"use strict";

const http2 = require("http2");
const zlib = require("zlib");
const {once} = require("events");
const {pipeline} = require("stream");

const timeout = time => new Promise(resolve => setTimeout(resolve, time));

class ESIRequest {
    constructor({
        esi_url = "https://esi.evetech.net",
        http2_options = {},
        default_headers = {},
        default_query = {},
        max_time = 30000,
        max_retries = 3,
        retry_delay = () => [3000, 10000, 15000],
        strip_headers = [
            "access-control-allow-credentials",
            "access-control-allow-headers",
            "access-control-allow-methods",
            "access-control-allow-origin",
            "access-control-expose-headers",
            "access-control-max-age",
            "strict-transport-security"
        ]
    } = {}) {
        this.esi_url = esi_url;
        this.http2_options = http2_options;
        this.default_headers = default_headers;
        this.default_query = default_query;
        this.max_time = max_time;
        this.max_retries = max_retries;
        this.retry_delay = retry_delay;
        this.strip_headers = strip_headers;
        this.http2_connect();
    }

    http2_connect() {
        this.session = http2.connect(this.esi_url, this.http2_options);
        // When many requests are initiated before the session has finished connecting, a warning will be emitted:
        // MaxListenersExceededWarning: Possible EventEmitter memory leak detected. 11 connect listeners added. Use emitter.setMaxListeners() to increase limit
        // This is probably due to each of the requests registering their own listener on the session's connect event.
        // For the time being, I'll follow the warning's advice and remove the limit altogether.
        this.session.setMaxListeners(0);
    }

    // Make a request over the active HTTP/2 session.
    // Also handle JSON encoding/decoding of the request/response bodies.
    async _make_request(path, options) {
        let {method, headers, query, body, token, previous_response} = options;
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
        let request = this.session.request(request_headers);
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
            pipeline(request, decompress, () => {});
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
                    return {status, headers: response_headers, data};
                }
                catch (error) {
                    error.response = {status, headers: response_headers, body: response_body};
                    throw error;
                }
            } else {
                let error = new Error("Response wasn't JSON");
                error.response = {status, headers: response_headers, body: response_body};
                throw error;
            }
        } else if (status === 304) {
            return {status, headers: response_headers, data: previous_response.data};
        } else {
            return {status, headers: response_headers};
        }
    }

    // Make a request, retrying if an error likely to be temporary occurs.
    async _retry_request(path, options) {
        let attempts = this.max_retries + 1, time_limit = Date.now() + this.max_time;
        let delay_iterator = this.retry_delay()[Symbol.iterator]();
        let responses = [];
        while (attempts > 0 && time_limit > Date.now()) {
            let response = await this._make_request(path, options);
            let {status} = response;
            responses.push(response);
            attempts--;
            if (status >= 200 && status <= 299 || status === 304) {
                // 2xx class codes indicate success, and 304 indicates the previous response was reused.
                return response;
            } else if (status >= 502 && status <= 504) {
                // Codes 502, 503, and 504 indicate temporary errors, the request should be retried after a while.
                let delay = delay_iterator.next();
                if (delay.value) {
                    await timeout(delay.value);
                } else {
                    break;
                }
            } else {
                // All other status codes are assumed to be unrecoverable errors.
                // If an error message isn't available from the JSON response, use the status code as one.
                throw Object.assign(new Error(response.data && response.data.error || status), {responses});
            }
        }
        throw Object.assign(new Error("Retry limit reached"), {responses});
    }

    // Make a GET request, requesting all pages and merging them if the response is spread over multiple pages.
    // Will not work if the endpoint does not use the ESI X-Pages pagination style.
    async _paginate_get(path, options) {
        let {previous_response} = options, previous_responses = [];
        if (previous_response) {
            previous_responses = previous_response.responses || [previous_response];
        }
        let first_page = await this._retry_request(path, {...options, previous_response: previous_responses[0]});
        let pages = Number(first_page.headers["x-pages"]) || 1;
        // Request additional pages, if there are any.
        if (pages > 1) {
            let page_numbers = new Array(pages - 1).fill(undefined).map((_, i) => i + 2);
            let other_pages = await Promise.all(page_numbers.map(page => this._retry_request(path, {
                ...options,
                query: {...options.query, page},
                previous_response: previous_responses[page - 1]
            })));
            let responses = [first_page, ...other_pages];
            return {
                data: responses.map(response => response.data).flat(),
                responses
            };
        } else {
            return first_page;
        }
    }

    // Make a POST request, splitting the request body into multiple pages.
    // Will only work if both the request and response bodies are arrays.
    async _paginate_post(path, options) {
        let {body, body_page_size} = options;
        let body_chunks = [], body_copy = Array.from(body);
        while (body_copy.length) {
            body_chunks.push(body_copy.splice(0, body_page_size));
        }
        let responses = await Promise.all(body_chunks.map(body_chunk => this._retry_request(path, {...options, body: body_chunk})));
        return {
            data: responses.map(response => response.data).flat(),
            responses
        };
    }

    request(path, options = {}) {
        let {method, body, body_page_size} = options;
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
