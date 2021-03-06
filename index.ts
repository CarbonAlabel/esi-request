import {once} from "events";
import {pipeline} from "stream";
import {createGunzip, createInflate, createBrotliDecompress} from "zlib";
import {connect as http2Connect} from "http2";
import type {ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders, OutgoingHttpHeaders, SecureClientSessionOptions} from "http2";

function timeout(time: number): Promise<void> {
    return new Promise(resolve => setTimeout(resolve, time));
}

// Returns a generator function implementing a form of exponential backoff.
function exponential_backoff(base_delay: number, max_multiplier: number, multiplier_growth: number = 2) {
    return function* () {
        let multiplier = 1;
        while (true) {
            // The delay is randomized +/-25% from the mean.
            yield base_delay * multiplier * (0.75 + Math.random() / 2);
            multiplier = Math.min(max_multiplier, multiplier * multiplier_growth);
        }
    };
}

// Custom error class with utility functions.
class ESIError extends Error {
    response?: ESIResponse;

    constructor(message: string, response?: ESIResponse) {
        super(message);
        this.response = response;
        Error.captureStackTrace(this, ESIError);
    }

    // Attach a response object to an existing error.
    static from(error: Error, response: ESIResponse): ESIError {
        error["response"] = response;
        return error;
    }

    // Generate an error based on a response object.
    static fromResponse(response: ESIResponse) {
        let message: string;
        // If an error message isn't available from the JSON response, use the status code as one.
        if (response.data && response.data.error) {
            message = response.data.error;
        } else {
            message = "Response code " + response.status;
        }
        return new ESIError(message, response);
    }
}
ESIError.prototype.name = "ESIError";

interface ESIConnectionWrapper {
    request(headers: OutgoingHttpHeaders): ClientHttp2Stream | Promise<ClientHttp2Stream>;
    close(): void;
}

type PendingRequest = {
    headers: OutgoingHttpHeaders,
    timestamp: number,
    resolve_function: (request: ClientHttp2Stream) => void,
    reject_function: (error: Error) => void
};

type ESIConnectionSettings = Pick<ESIConnection, "esi_url" | "http2_options" | "reconnect_delay" | "max_pending_time">

// Basic HTTP/2 session wrapper.
// Reconnects if the connection is broken, and queues requests until a HTTP/2 session is available.
class ESIConnection implements ESIConnectionWrapper {
    session: ClientHttp2Session;
    request_queue: PendingRequest[] = [];
    closed: boolean = false;
    esi_url: string;
    http2_options: SecureClientSessionOptions;
    reconnect_delay: () => Iterable<number>;
    max_pending_time: number;
    constructor({
        esi_url = "https://esi.evetech.net",
        http2_options = {},
        reconnect_delay = exponential_backoff(500, 64),
        max_pending_time = 10000
    }: Partial<ESIConnectionSettings> = {}) {
        Object.assign(this, {
            esi_url,
            http2_options,
            reconnect_delay,
            max_pending_time
        });
        this.reconnect();
    }

    // Send pending requests from the request queue.
    private send_pending() {
        for (let pending of this.request_queue) {
            pending.resolve_function(this.session.request(pending.headers));
        }
    }

    // Reject pending requests that have been in the request queue for too long.
    private reject_old() {
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
    private async reconnect() {
        let delay_iterator = this.reconnect_delay()[Symbol.iterator]();
        while (true) {
            // Stop trying to reconnect if the session was explicitly closed. 
            if (this.closed) return;
            try {
                let session = http2Connect(this.esi_url, this.http2_options);
                // Will throw if an error occurs before the connection is established.
                await once(session, "connect");
                // Register event listeners, and start using the session.
                this.session = session;
                this.session.on("error", () => {});
                this.session.on("close", () => {
                    this.reconnect();
                });
                // Send any pending requests.
                this.send_pending();
                return;
            } catch {
                // A reconnection attempt just failed, this is a good time to reject requests that have been waiting too long.
                this.reject_old();
                let delay = delay_iterator.next();
                await timeout(delay.value);
            }
        }
    }

    request(headers: OutgoingHttpHeaders): ClientHttp2Stream | Promise<ClientHttp2Stream> {
        if (!this.session || this.session.connecting || this.session.closed || this.session.destroyed) {
            let resolve_function, reject_function;
            let promise: Promise<ClientHttp2Stream> = new Promise((resolve, reject) => {
                resolve_function = resolve;
                reject_function = reject;
            });
            this.request_queue.push({headers, timestamp: Date.now(), resolve_function, reject_function});
            return promise;
        } else {
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
class ESIConnectionPool implements ESIConnectionWrapper {
    sessions: ESIConnection[];
    index: number = 0;
    size: number;

    constructor(size: number, settings: Partial<ESIConnectionSettings> = {}) {
        this.size = size;
        this.sessions = new Array(size).fill(undefined).map(() => new ESIConnection(settings));
    }

    request(headers: OutgoingHttpHeaders) {
        return this.sessions[this.index++ % this.size].request(headers);
    }

    close() {
        for (let session of this.sessions) {
            session.close();
        }
    }
}

type ESIRequestOptions = Partial<{
    method: "GET" | "POST" | "PUT" | "DELETE" | "HEAD" | "OPTIONS";
    headers: OutgoingHttpHeaders;
    parameters: object;
    query: object;
    body: any;
    body_page_size: number;
    token: string | Promise<string> | (() => string | Promise<string>);
    previous_response: ESIResponse;
}>

type ESIResponse = {
    status: number;
    headers: IncomingHttpHeaders;
    body?: string;
    data?: any;
    responses?: ESIResponse[];
}

type ESIResponsePromise = Promise<ESIResponse> & {
    data: Promise<any>
};

// Add utility getters to an ESIResponse promise, making direct access to the response data easier.
function addUtilityGetters(response: Promise<ESIResponse>): ESIResponsePromise {
    return Object.defineProperties(response, {
        data: {get: getData}
    });
}
function getData(): Promise<any> {
    return this.then((r: ESIResponse) => r.data);
}

type ESIRequestSettings = {
    connection: ESIConnectionWrapper;
    connection_settings: Partial<ESIConnectionSettings>;
    pool_size: number;
} & Pick<ESIRequest, "default_headers" | "default_query" | "max_time" | "max_retries" | "retry_delay_low" | "retry_delay_high" | "page_split_delay" | "strip_headers">;

export class ESIRequest {
    connection: ESIConnectionWrapper;
    default_headers: object;
    default_query: object;
    max_time: number;
    max_retries: number;
    retry_delay_low: () => Iterable<number>;
    retry_delay_high: () => Iterable<number>;
    page_split_delay: (pages: number) => number;
    strip_headers: string[];
    constructor({
        connection,
        connection_settings = {},
        pool_size = 1,
        default_headers = {},
        default_query = {},
        max_time = 10000,
        max_retries = 3,
        retry_delay_low = exponential_backoff(500, 30, 3),
        retry_delay_high = exponential_backoff(15000, 4),
        page_split_delay = pages => pages * 75 + 2500,
        strip_headers = [
            "access-control-allow-credentials",
            "access-control-allow-headers",
            "access-control-allow-methods",
            "access-control-allow-origin",
            "access-control-expose-headers",
            "access-control-max-age",
            "strict-transport-security"
        ]
    }: Partial<ESIRequestSettings> = {}) {
        //
        if (connection) {
            this.connection = connection;
        } else if (Number.isInteger(pool_size) && pool_size > 1) {
            this.connection = new ESIConnectionPool(pool_size, connection_settings);
        } else {
            this.connection = new ESIConnection(connection_settings);
        }
        Object.assign(this, {
            default_headers,
            default_query,
            max_time,
            max_retries,
            retry_delay_low,
            retry_delay_high,
            page_split_delay,
            strip_headers
        });
    }

    // Make a request over the active connection.
    // Also handle JSON encoding/decoding of the request/response bodies.
    private async _make_request(path: string, options: ESIRequestOptions): Promise<ESIResponse> {
        let {method, headers, parameters, query, body, token, previous_response} = options;
        let request_path = path;
        for (let token of path.match(/{\w+}/g) || []) {
            let name = token.slice(1, -1);
            if (name in parameters) {
                request_path = request_path.replace(token, parameters[name]);
            } else {
                throw new ESIError(`Value for URL parameter "${name}" was not provided`);
            }
        }
        let query_string = new URLSearchParams({
            ...this.default_query,
            ...query
        }).toString();
        if (query_string) {
            request_path += "?" + query_string;
        }
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
        let request = await this.connection.request(request_headers);
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
                "gzip": createGunzip,
                "deflate": createInflate,
                "br": createBrotliDecompress
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
                    throw ESIError.from(error, {status, headers: response_headers, body: response_body});
                }
            } else {
                return {status, headers: response_headers, body: response_body};
            }
        } else if (status === 304) {
            status = previous_response.status;
            return {status, headers: response_headers, data: previous_response.data};
        } else {
            return {status, headers: response_headers};
        }
    }

    // Make a request, retrying if an error likely to be temporary occurs.
    private async _retry_request(path: string, options: ESIRequestOptions): Promise<ESIResponse> {
        let attempts = this.max_retries + 1, time_limit = Date.now() + this.max_time;
        let delay_iterator_low = this.retry_delay_low()[Symbol.iterator]();
        let delay_iterator_high = this.retry_delay_high()[Symbol.iterator]();
        let response: ESIResponse;
        while (attempts > 0 && time_limit > Date.now()) {
            response = await this._make_request(path, options);
            let {status} = response;
            attempts--;
            if (status >= 200 && status <= 299) {
                // 2xx class codes indicate success.
                return response;
            } else if (status >= 502 && status <= 504) {
                // Codes 502, 503, and 504 indicate temporary errors, the request should be retried after a while.
                let delay: number;
                // If present, parse the Retry-After header.
                if (response.headers["retry-after"]) {
                    let seconds = Number(response.headers["retry-after"]);
                    if (Number.isInteger(seconds)) {
                        delay = seconds * 1000;
                    } else {
                        delay = Date.parse(response.headers["retry-after"]) - Date.parse(response.headers["date"]) + 1000;
                    }
                }
                // If the Retry-After header wasn't present or was invalid, use the delay generators.
                if (!delay || delay < 0) {
                    // Errors returned by ESI count against the error limit, and are usually caused by longer-lasting events.
                    // A higher delay time should be used.
                    if ("x-esi-error-limit-reset" in response.headers) {
                        delay = delay_iterator_high.next().value;
                    } else {
                        delay = delay_iterator_low.next().value;
                    }
                }
                // If the calculated delay would exceed the time limit, stop immediately.
                if (delay > time_limit - Date.now()) {
                    break;
                }
                // Wait before retrying the request.
                await timeout(delay);
            } else {
                // All other status codes are assumed to be unrecoverable errors.
                throw ESIError.fromResponse(response);
            }
        }
        throw new ESIError("Retry limit reached", response);
    }

    // Finds the common headers from an array of response objects.
    static common_headers(responses: ESIResponse[]): IncomingHttpHeaders {
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

    // Make a GET request, requesting all pages and merging them if the response is spread over multiple pages.
    // Will not work if the endpoint does not use the ESI X-Pages pagination style.
    private async _paginate_get(path: string, options: ESIRequestOptions): Promise<ESIResponse> {
        let {previous_response} = options, previous_responses = [];
        if (previous_response) {
            previous_responses = previous_response.responses || [previous_response];
        }

        // Request the first page.
        let first_page = await this._retry_request(path, {...options, previous_response: previous_responses[0]});
        let pages = Number(first_page.headers["x-pages"]) || 1;

        // If there are multiple pages, keep going.
        if (pages > 1) {
            // Page split prevention:
            // If the cache for the endpoint will expire soon, wait for it to expire and repeat the request.
            // This measure, while significantly decreasing it, does not completely eliminate the possibility of a page split occurring.
            let expires_in = Date.parse(first_page.headers["expires"]) - Date.parse(first_page.headers["date"]) + 1000;
            let calculated_delay = this.page_split_delay(pages);
            if (expires_in < calculated_delay) {
                await timeout(expires_in);
                first_page = await this._retry_request(path, {...options, previous_response: previous_responses[0]});
                pages = Number(first_page.headers["x-pages"]) || 1;
            }

            // Request additional pages.
            let page_numbers = new Array(pages - 1).fill(undefined).map((_, i) => i + 2);
            let other_pages = await Promise.all(page_numbers.map(page => this._retry_request(path, {
                ...options,
                query: {...options.query, page},
                previous_response: previous_responses[page - 1]
            })));
            let responses = [first_page, ...other_pages];
            let headers = ESIRequest.common_headers(responses);

            // The expires header not being in the common headers is indication of a page split, an error should be thrown.
            if (!headers["expires"]) {
                throw new ESIError("Page split detected");
            }

            // Combine the responses and return them.
            let status = first_page.status;
            let data = responses.flatMap(response => response.data);
            return {status, headers, data, responses};
        } else {
            // There is only one page, return it.
            return first_page;
        }
    }

    // Make a POST request, splitting the request body into multiple pages.
    // Will only work if both the request and response bodies are arrays.
    private async _paginate_post(path: string, options: ESIRequestOptions): Promise<ESIResponse> {
        let {body, body_page_size} = options;
        let body_chunks = [], body_copy = Array.from(body);
        while (body_copy.length) {
            body_chunks.push(body_copy.splice(0, body_page_size));
        }
        let responses = await Promise.all(body_chunks.map(body_chunk => this._retry_request(path, {...options, body: body_chunk})));
        let headers = ESIRequest.common_headers(responses);
        let status = responses[0].status;
        let data = responses.flatMap(response => response.data);
        return {status, headers, data, responses};
    }

    request(path: string, options: ESIRequestOptions = {}): ESIResponsePromise {
        let response: Promise<ESIResponse>;
        let {method, body, body_page_size} = options;
        // By default, perform a GET request with pagination.
        if ((method || "GET") === "GET") {
            response = this._paginate_get(path, options);
        }
        // If the parameters required for a paginated POST request are present, do that instead.
        else if (method === "POST" && Number.isInteger(body_page_size) && Array.isArray(body)) {
            response = this._paginate_post(path, options);
        }
        // Otherwise, perform a single request.
        else {
            response = this._retry_request(path, options);
        }
        // Return the response promise with utility getters.
        return addUtilityGetters(response);
    }

    get close() {
        return () => this.connection.close();
    }
}
