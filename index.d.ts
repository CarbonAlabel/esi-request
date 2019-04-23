/// <reference types="node" />

import { ClientHttp2Session, IncomingHttpHeaders, OutgoingHttpHeaders, SecureClientSessionOptions } from "http2";

interface ESIRequestProperties {
    esi_url: string;
    http2_options: SecureClientSessionOptions;
    default_headers: object;
    default_query: object;
    max_time: number;
    max_retries: number;
    retry_delay: () => Iterable<number>;
    strip_headers: string[];
}

interface ESIRequestOptions {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    headers?: OutgoingHttpHeaders;
    query?: object;
    body?: any;
    body_page_size?: number;
    token?: string | Promise<string> | (() => string | Promise<string>);
    previous_response?: ESIRequestResponse;
}

interface ESIRequestResponse {
    headers?: IncomingHttpHeaders;
    body?: string;
    data?: any;
    responses?: ESIRequestResponse[];
}

class ESIRequest implements ESIRequestProperties {
    session: ClientHttp2Session;
    constructor(options?: Partial<ESIRequestProperties>);
    async request(path: string, options?: ESIRequestOptions): Promise<ESIRequestResponse>;
}

export = ESIRequest;
