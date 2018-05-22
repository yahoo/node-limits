limits
=======

Simple express/connect middleware to set limit to upload size, set request timeout etc.

It is responsible for:

### Enforcing HTTP timeouts

* Setting a global absolute timeout for both incoming and outgoing connections
  In config, use: `{ global_timeout: [millis] }`, if 0  - no timeout is set

* Setting a global absolute timeout for incoming connections only
  In config, use: `{ inc_req_timeout: [millis] }`, if 0  - no timeout is set

* Setting a global absolute timeout for outgoing connections only
  In config, use: `{ out_req_timeout: [millis] }`, if 0  - no timeout is set

* Setting idle timeout for incoming connections
  In config, use: `{ idle_timeout: [millis] }`, if 0  - no timeout is set

_Note_: Apart from `idle_timeout`, each of these settings applies to
the complete roundtrip request/response cycle.  For example, `inc_req_timeout`
applies to the interval from when the server receives an incoming request to
the time that the corresponding response is sent.  `out_req_timeout`
applies to the interval from when a client request is sent to the time the
response is received (and the socket freed).

_Warning for Node v4.x_: The outgoing request timeout mechanism does
not work for keepAlive connections in Node v4.x and earlier.  Instead,
in Node v4.x, this timeout is applied only if the outgoing
ClientRequest is marked as *not* keepAlive at the time the socket is
attached to the request.

### Ancillary HTTP limits

* Preventing upload completely.  In config, use: `{ file_uploads:
  false }`

* Limiting the total size of upload
  In config, use: `{ post_max_size: [bytes] }`, if 0, this functionality is disabled
  
* Limiting the length of uri
  In config, use: `{ uri_max_length: [number] }`, if 0 this functionality is disabled

* Setting the http.Agent.defaultMaxSockets for the entire app.
  In config, use: `{ max_sockets: [number] }`, if 0  - nothing will be set.
  Note: this applies only to the *http* global agent.

* Setting incoming/outgoing socket noDelay (i.e. disable Nagle's algorithm)
  In config, use: `{ socket_no_delay: [boolean] }`, if false  - nothing will be set.

To completely disable module use config, `{ enable: false }`.

Functionality for a specific feature will be disabled if the
corresponding config attribute is not set.

install
-------
With npm do:

`npm install limits`

usage
-----

```javascript
var express = require('express'),
    limits = require('limits');

var app = express();

var limits_config = {
    enable: true,
    file_uploads: true,
    post_max_size: 2000000
}

app.use(limits(limits_config));

app.listen(8000);
```
Build Status
------------

[![Build Status](https://secure.travis-ci.org/yahoo/node-limits.png?branch=master)](http://travis-ci.org/yahoo/node-limits)

Node Badge
----------

[![NPM](https://nodei.co/npm/limits.png)](https://nodei.co/npm/limits/)
