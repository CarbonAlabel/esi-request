/// <reference types="node" />
import { ClientHttp2Session, IncomingHttpHeaders, OutgoingHttpHeaders, SecureClientSessionOptions } from "http2";
interface ESIRequestOptions {
    method?: "GET" | "POST" | "PUT" | "DELETE";
    headers?: OutgoingHttpHeaders;
    query?: object;
    body?: any;
    body_page_size?: number;
    token?: string | Promise<string> | (() => string | Promise<string>);
    previous_response?: ESIResponse;
}
interface ESIResponse {
    status?: number;
    headers?: IncomingHttpHeaders;
    body?: string;
    data?: any;
    responses?: ESIResponse[];
}
declare class ESIRequest {
    session: ClientHttp2Session;
    esi_url: string;
    http2_options: SecureClientSessionOptions;
    default_headers: object;
    default_query: object;
    max_time: number;
    max_retries: number;
    retry_delay: () => Iterable<number>;
    page_split_delay: (pages: number) => number;
    strip_headers: string[];
    constructor({ esi_url, http2_options, default_headers, default_query, max_time, max_retries, retry_delay, page_split_delay, strip_headers }?: Partial<ESIRequest>);
    http2_connect(): void;
    private _make_request;
    private _retry_request;
    private _paginate_get;
    private _paginate_post;
    request(path: string, options?: ESIRequestOptions): Promise<ESIResponse>;
}
export = ESIRequest;
