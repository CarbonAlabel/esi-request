/// <reference types="node" />
import { ClientHttp2Session, ClientHttp2Stream, IncomingHttpHeaders, OutgoingHttpHeaders, SecureClientSessionOptions } from "http2";
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
declare type PendingRequest = {
    headers: OutgoingHttpHeaders;
    timestamp: number;
    resolve_function: (request: ClientHttp2Stream) => void;
    reject_function: (error: Error) => void;
};
declare type ESISessionConfig = Pick<ESISession, "esi_url" | "http2_options" | "reconnect_delay" | "max_pending_time">;
declare class ESISession {
    session: ClientHttp2Session;
    request_queue: PendingRequest[];
    closed: boolean;
    esi_url: string;
    http2_options: SecureClientSessionOptions;
    reconnect_delay: () => Iterable<number>;
    max_pending_time: number;
    constructor({ esi_url, http2_options, reconnect_delay, max_pending_time }?: Partial<ESISessionConfig>);
    private send_pending;
    private reject_old;
    private reconnect;
    request(headers: OutgoingHttpHeaders): ClientHttp2Stream | Promise<ClientHttp2Stream>;
    close(): void;
}
declare type ESISessionPoolConfig = ESISessionConfig & Pick<ESISessionPool, "size">;
declare class ESISessionPool {
    sessions: ESISession[];
    index: number;
    size: number;
    constructor(options?: Partial<ESISessionPoolConfig>);
    request(headers: OutgoingHttpHeaders): ClientHttp2Stream | Promise<ClientHttp2Stream>;
    close(): void;
}
declare class ESIRequest {
    session: ESISession | ESISessionPool;
    esi_url: string;
    http2_options: SecureClientSessionOptions;
    pool_size: number;
    default_headers: object;
    default_query: object;
    max_time: number;
    max_retries: number;
    retry_delay: () => Iterable<number>;
    page_split_delay: (pages: number) => number;
    strip_headers: string[];
    constructor({ esi_url, http2_options, pool_size, default_headers, default_query, max_time, max_retries, retry_delay, page_split_delay, strip_headers }?: Partial<ESIRequest>);
    private _make_request;
    private _retry_request;
    private _paginate_get;
    private _paginate_post;
    request(path: string, options?: ESIRequestOptions): Promise<ESIResponse>;
}
export = ESIRequest;
