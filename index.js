"use strict";
const http2 = require("http2");
const zlib = require("zlib");
const { once } = require("events");
const { pipeline } = require("stream");
const timeout = time => new Promise(resolve => setTimeout(resolve, time));
// Finds the common headers from an array of response objects.
function common_headers(responses) {
    // Clone the first response's headers.
    let common = Object.assign({}, responses[0].headers);
    // Iterate through the remaining responses.
    for (let response of responses.slice(1)) {
        // If the header values don't match, delete the header.
        for (let header in common) {
            if (common[header] !== response.headers[header]) {
                delete common[header];
            }
        }
    }
    return common;
}
// Basic HTTP/2 session wrapper.
// Reconnects if the connection is broken, and queues requests until a HTTP/2 session is available.
class ESISession {
    constructor({ esi_url = "https://esi.evetech.net", http2_options = {}, reconnect_delay = function* () {
        let base_delay = 500, multiplier = 1, max_multiplier = 64;
        while (true) {
            yield base_delay * multiplier * (0.75 + Math.random() / 2);
            multiplier = Math.min(max_multiplier, multiplier * 2);
        }
    }, max_pending_time = 30000 } = {}) {
        this.request_queue = [];
        this.closed = false;
        Object.assign(this, {
            esi_url,
            http2_options,
            reconnect_delay,
            max_pending_time
        });
        this.reconnect();
    }
    // Send pending requests from the request queue.
    send_pending() {
        for (let pending of this.request_queue) {
            pending.resolve_function(this.session.request(pending.headers));
        }
    }
    // Reject pending requests that have been in the request queue for too long.
    reject_old() {
        // Find the index of the first request that isn't too old.
        let index = this.request_queue.findIndex((request) => Date.now() - request.timestamp < this.max_pending_time);
        if (index === 0) {
            // None of the requests are too old, no further action is required.
            return;
        }
        if (index === -1) {
            // All of the requests are too old.
            index = this.request_queue.length;
        }
        // Reject all the old requests.
        for (let request of this.request_queue.slice(0, index)) {
            request.reject_function(new Error("Waited too long for a connection"));
        }
        // Leave the remaining requests in the queue.
        this.request_queue = this.request_queue.slice(index);
    }
    // Repeatedly try to reconnect.
    // Also used for making the initial connection.
    async reconnect() {
        let delay_iterator = this.reconnect_delay()[Symbol.iterator]();
        while (true) {
            // Stop trying to reconnect if the session was explicity closed. 
            if (this.closed)
                return;
            try {
                let session = new http2.connect(this.esi_url, this.http2_options);
                // Will throw if an error occurs before the connection is established.
                await once(session, "connect");
                // Register event listeners, and start using the session.
                this.session = session;
                this.session.on("error", () => { });
                this.session.on("close", () => {
                    this.reconnect();
                });
                // Send any pending requests.
                this.send_pending();
                return;
            }
            catch {
                // A reconnection attempt just failed, this is a good time to reject requests that have been waiting too long.
                this.reject_old();
                let delay = delay_iterator.next();
                await timeout(delay.value);
            }
        }
    }
    request(headers) {
        if (!this.session || this.session.connecting || this.session.closed || this.session.destroyed) {
            let resolve_function, reject_function;
            let promise = new Promise((resolve, reject) => {
                resolve_function = resolve;
                reject_function = reject;
            });
            this.request_queue.push({ headers, timestamp: Date.now(), resolve_function, reject_function });
            return promise;
        }
        else {
            return this.session.request(headers);
        }
    }
    close() {
        this.closed = true;
        if (this.session) {
            this.session.close();
        }
    }
}
// Advanced HTTP/2 session wrapper.
// Spreads requests over multiple HTTP/2 sessions.
class ESISessionPool {
    constructor(options = {}) {
        this.index = 0;
        let size = options.size || 2;
        this.size = size;
        this.sessions = new Array(size).fill(undefined).map(() => new ESISession(options));
    }
    request(headers) {
        return this.sessions[this.index++ % this.size].request(headers);
    }
    close() {
        for (let session of this.sessions) {
            session.close();
        }
    }
}
class ESIRequest {
    constructor({ esi_url = "https://esi.evetech.net", http2_options = {}, pool_size = 1, default_headers = {}, default_query = {}, max_time = 30000, max_retries = 3, retry_delay = () => [3000, 10000, 15000], page_split_delay = pages => pages * 75 + 2500, strip_headers = [
        "access-control-allow-credentials",
        "access-control-allow-headers",
        "access-control-allow-methods",
        "access-control-allow-origin",
        "access-control-expose-headers",
        "access-control-max-age",
        "strict-transport-security"
    ] } = {}) {
        if (pool_size > 1) {
            this.session = new ESISessionPool({
                size: pool_size,
                esi_url,
                http2_options
            });
        }
        else {
            this.session = new ESISession({
                esi_url,
                http2_options
            });
        }
        this.default_headers = default_headers;
        this.default_query = default_query;
        this.max_time = max_time;
        this.max_retries = max_retries;
        this.retry_delay = retry_delay;
        this.page_split_delay = page_split_delay;
        this.strip_headers = strip_headers;
    }
    // Make a request over the active HTTP/2 session.
    // Also handle JSON encoding/decoding of the request/response bodies.
    async _make_request(path, options) {
        let { method, headers, query, body, token, previous_response } = options;
        let query_string = new URLSearchParams({
            ...this.default_query,
            ...query
        }).toString();
        let request_path = path + (query_string ? "?" + query_string : "");
        let request_headers = {
            ...this.default_headers,
            ...headers,
            // Announce supported compression types.
            // "accept-encoding": "gzip, deflate, br",
            "accept-encoding": "gzip, deflate",
            ":method": method,
            ":path": request_path
        };
        if (token) {
            let token_string = token instanceof Function ? await token() : await token;
            request_headers["authorization"] = "Bearer " + token_string;
        }
        if (previous_response && previous_response.headers && previous_response.headers["etag"]) {
            request_headers["if-none-match"] = previous_response.headers["etag"];
        }
        // Encode the request body as JSON.
        let request_body;
        if (body) {
            request_body = JSON.stringify(body);
        }
        // Start the request by sending the headers, send the body if there is one, and end it.
        let request = await this.session.request(request_headers);
        if (request_body) {
            request.write(request_body);
        }
        request.end();
        // Wait for the response headers.
        let [response_headers] = await once(request, "response");
        let status = response_headers[":status"];
        // Strip irrelevant header fields.
        for (let header of this.strip_headers) {
            delete response_headers[header];
        }
        // If the response is compressed, decompress it.
        let stream = request;
        if (["gzip", "deflate", "br"].includes(response_headers["content-encoding"])) {
            let decompress = {
                "gzip": zlib.createGunzip,
                "deflate": zlib.createInflate,
                "br": zlib.createBrotliDecompress
            }[response_headers["content-encoding"]]();
            stream = decompress;
            pipeline(request, decompress, () => { });
        }
        // Read the response body.
        let chunks = [];
        for await (let chunk of stream) {
            chunks.push(chunk);
        }
        let response_body = Buffer.concat(chunks).toString();
        // Process the response.
        if (response_body) {
            if (response_headers["content-type"] && response_headers["content-type"].includes("application/json")) {
                try {
                    let data = JSON.parse(response_body);
                    return { status, headers: response_headers, data };
                }
                catch (error) {
                    error.response = { status, headers: response_headers, body: response_body };
                    throw error;
                }
            }
            else {
                let error = new Error("Response wasn't JSON");
                error.response = { status, headers: response_headers, body: response_body };
                throw error;
            }
        }
        else if (status === 304) {
            status = previous_response.status;
            return { status, headers: response_headers, data: previous_response.data };
        }
        else {
            return { status, headers: response_headers };
        }
    }
    // Make a request, retrying if an error likely to be temporary occurs.
    async _retry_request(path, options) {
        let attempts = this.max_retries + 1, time_limit = Date.now() + this.max_time;
        let delay_iterator = this.retry_delay()[Symbol.iterator]();
        let responses = [];
        while (attempts > 0 && time_limit > Date.now()) {
            let response = await this._make_request(path, options);
            let { status } = response;
            responses.push(response);
            attempts--;
            if (status >= 200 && status <= 299 || status === 304) {
                // 2xx class codes indicate success, and 304 indicates the previous response was reused.
                return response;
            }
            else if (status >= 502 && status <= 504) {
                // Codes 502, 503, and 504 indicate temporary errors, the request should be retried after a while.
                let delay = delay_iterator.next();
                if (delay.value) {
                    await timeout(delay.value);
                }
                else {
                    break;
                }
            }
            else {
                // All other status codes are assumed to be unrecoverable errors.
                // If an error message isn't available from the JSON response, use the status code as one.
                throw Object.assign(new Error(response.data && response.data.error || status), { responses });
            }
        }
        throw Object.assign(new Error("Retry limit reached"), { responses });
    }
    // Make a GET request, requesting all pages and merging them if the response is spread over multiple pages.
    // Will not work if the endpoint does not use the ESI X-Pages pagination style.
    async _paginate_get(path, options) {
        let { previous_response } = options, previous_responses = [];
        if (previous_response) {
            previous_responses = previous_response.responses || [previous_response];
        }
        let first_page = await this._retry_request(path, { ...options, previous_response: previous_responses[0] });
        let pages = Number(first_page.headers["x-pages"]) || 1;
        // Page split prevention:
        // If there are multiple pages, and the cache for the endpoint will expire soon, wait for it to expire and repeat the request.
        // This measure, while significantly decreasing it, does not completely eliminate the possibility of a page split occurring.
        if (pages > 1) {
            let expires_in = Date.parse(first_page.headers["expires"]) - Date.parse(first_page.headers["date"]) + 1000;
            let calculated_delay = this.page_split_delay(pages);
            if (expires_in < calculated_delay) {
                await timeout(expires_in);
                first_page = await this._retry_request(path, { ...options, previous_response: previous_responses[0] });
                pages = Number(first_page.headers["x-pages"]) || 1;
            }
        }
        // Request additional pages, if there are any.
        if (pages > 1) {
            let page_numbers = new Array(pages - 1).fill(undefined).map((_, i) => i + 2);
            let other_pages = await Promise.all(page_numbers.map(page => this._retry_request(path, {
                ...options,
                query: { ...options.query, page },
                previous_response: previous_responses[page - 1]
            })));
            let responses = [first_page, ...other_pages];
            let headers = common_headers(responses);
            // The expires header not being in the common headers is indication of a page split, an error should be thrown.
            if (!headers["expires"]) {
                let error = new Error("Page split detected");
                error.responses = responses;
                throw error;
            }
            let status = first_page.status;
            let data = responses.map(response => response.data).flat();
            return { status, headers, data, responses };
        }
        else {
            return first_page;
        }
    }
    // Make a POST request, splitting the request body into multiple pages.
    // Will only work if both the request and response bodies are arrays.
    async _paginate_post(path, options) {
        let { body, body_page_size } = options;
        let body_chunks = [], body_copy = Array.from(body);
        while (body_copy.length) {
            body_chunks.push(body_copy.splice(0, body_page_size));
        }
        let responses = await Promise.all(body_chunks.map(body_chunk => this._retry_request(path, { ...options, body: body_chunk })));
        let headers = common_headers(responses);
        let status = responses[0].status;
        let data = responses.map(response => response.data).flat();
        return { status, headers, data, responses };
    }
    request(path, options = {}) {
        let { method, body, body_page_size } = options;
        // By default, perform a GET request with pagination.
        if ((method || "GET") === "GET") {
            return this._paginate_get(path, options);
        }
        // If the parameters required for a paginated POST request are present, do that instead.
        else if (method === "POST" && Number.isInteger(body_page_size) && Array.isArray(body)) {
            return this._paginate_post(path, options);
        }
        // Otherwise, perform a single request.
        else {
            return this._retry_request(path, options);
        }
    }
}
module.exports = ESIRequest;
