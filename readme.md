# esi-request

Zero-dependency Node.js library for making requests to EVE Online's ESI API.

## Features

* Simple promise-based interface.
* Utilizes HTTP/2 and request compression to make the most efficient use of your bandwidth.
* Automatic pagination of requests.
* Simple ETag usage.

## Not Included

* Caching.

## Usage

Node.js 13.2.0 or newer is required. Import the class, and create a new instance of it.

```js
import {ESIRequest} from "@esi/request";
const ESI = new ESIRequest();
```

**The documentation below may be slightly out of date**

Optionally, an options object can be passed to the constructor. Available options are:

* `esi_url`: URL of the ESI the instance should connect to. Defaults to https://esi.evetech.net. 
* `http2_options`: An options object to be passed to the Node http2 library. See the [Node.js documentation](https://nodejs.org/api/http2.html#http2_http2_connect_authority_options_listener) for full details on available options. Usage example: [markets.js](examples/markets.js)
* `default_headers`: HTTP headers to be added to all requests. Usage example: [defaults.js](examples/defaults.js)
* `default_query`: Query parameters to be added to all requests. Usage example: [defaults.js](examples/defaults.js)
* `max_time`: Maximum amount of time to spend retrying a single request, in milliseconds. Defaults to 30 seconds.
* `max_retries`: Maximum number of times to retry a single request. Defaults to 3.
* `retry_delay`: A function which returns a number producing iterable, telling the instance how long to wait before request retries. Defaults to fixed delays of 3, 10, and 15 seconds. Usage example: [status.js](examples/status.js)
* `strip_headers`: Array of header names which should be stripped from responses. Defaults to a list of CORS and STS headers which are irrelevant outside of a browser context.

Once the instance is ready, use the `request` method, preferably in an async context, to make requests to ESI.

```js
let status = await ESI.request("/v1/status/").data;
console.log(`There are currently ${status.players} players online.`);
```

In addition to the request path, an options object can be passed. Available options are:

* `method`: HTTP method to use for the request.
* `headers`: HTTP headers to be added to the request.
* `query`: Query parameters to be added to the request.
* `body`: Object to be sent as request body. 
* `body_page_size`: Used to split the request body into multiple parts. Usage example: [names.js](examples/names.js)
* `token`: SSO token to be used in the request. 
* `previous_response`: A response object object returned by a previous request. Usage example: [etags.js](examples/etags.js)

The promise should resolve to a response object:

* `headers`: Response headers.
* `data`: Parsed response body.
* `body`: Response body, present instead of `data` if the response wasn't a JSON document.
* `responses`: If pagination was performed, this will be an array containing the individual responses.

If the promise is rejected, the error may come with a `responses` property, which will be an array of response objects from requests made before giving up.
