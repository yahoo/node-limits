/*
 * Copyright (c) 2013, Yahoo! Inc. All rights reserved.
 * Copyrights licensed under the New BSD License.
 * See the accompanying LICENSE file for terms.
 */
var timers = require('timers'),
    http = require('http');

var globalOutgoing = 0,
    globalIncoming = 0,
    globalNoDelayFlag = false;

//overwrite the global functions to control the timeout behavior.
var hassign = http.ClientRequest.prototype.onSocket;

var nodeVersion = Number(process.versions.node.match(/^(\d+\.\d+)/)[1]);

function mergeConfig(global, local) {
    var result = {}, i;
    for (i in global) {
        if (global.hasOwnProperty(i)) {
            result[i] = global[i];
        }
    }
    for (i in local) {
        if (local.hasOwnProperty(i)) {
            result[i] = local[i];
        }
    }
    return result;
}

/*
 * This object is getting attached to each outgoing
 * request in order to limit the time request is processed.
 *
 * It might be used as idle- or total-time timer.
 * Obviously overhead of using it will not exceed 1000 timer objects per second,
 * since timers with the same expiration are getting bundled.
 *
 * @param message - the outgoing request object or outgoing response object.
 * @param t - timeout value
 */
function Closer(message, t) {
    this.message = message;
    message.__closer = this;

    timers.enroll(this, t);
    timers.active(this);
}

Closer.prototype = {

    _onTimeout : function node_limits_timeout() {
        if (this.message instanceof http.ClientRequest) {
            var abortError;
            this.message.abort();

            abortError = new Error('limits forced http.ClientRequest to time out');
            abortError.code = 'timeout';
            delete this.message.__closer;
            this.message.emit('error', abortError);
        } else if (this.message instanceof http.ServerResponse) {
            try {
                delete this.message.__closer;
                if (!this.message.headersSent) {
                    this.message.writeHead(504, 'Gateway Timeout', {'Content-Type': 'text/plain'});
                }
                if (!this.message.finished) {
                    this.message.end('504 Gateway Timeout');
                }
            } catch (e) {
            }
        }
    },
    /*
     * Removes the closer object from the request.
     */
    remove : function node_limits_remove() {
        timers.unenroll(this);
        if (this.message && this.message.__closer) {
            delete this.message.__closer;
        }
    }
};

http.ClientRequest.prototype.onSocket = function node_limits_onsocket(socket) {
    // Attach socket
    var s = hassign.apply(this, arguments),
        closer,
        self = this;

    if (globalNoDelayFlag) {
        socket.setNoDelay(true);
    }

    var freeFn = function node_limits_free() {
        if (socket._httpMessage === self) {
            // Detach socket
            if (self.__closer) {
                timers.unenroll(self.__closer);
                delete self.__closer;
            }
        }
    };

    if (globalOutgoing > 0 && self instanceof http.ClientRequest) {
        if (socket) {
            if (nodeVersion >= 6.0) {
                closer = new Closer(self, globalOutgoing);
                socket.prependOnceListener('free', freeFn);
            }
            else {
                // for Node < 6, prependListener does not exist
                // and we need it for keepAlive connections with agents to work
                //
                // Thus, we'll only add a timer to those requests which are *not* keepalive
                if (!self.shouldKeepAlive) {
                    closer = new Closer(self, globalOutgoing);
                    socket.once('free', freeFn);
                }
            }
        }
    }
    return s;
};

/*
 * This function sets the timeout value for incoming and outgoing requests
 * in order to limit the waiting time for back ends to the SLA.
 */
function exposeGlobalTimers(config) {

    // Sets the global timeout value for all outgoing requests
    process.setOutgoingRequestsTimeout = function (val) {
        globalOutgoing = val;
    };

    // Sets the global timeout value for all incoming requests
    process.setIncomingRequestsTimeout = function (val) {
        globalIncoming = val;
    };

    // Sets the global timeout value for all incoming and outgoing requests
    process.setAllRequestsTimeout = function (val) {
        globalOutgoing = val;
        globalIncoming = val;
    };

    // set values from config
    config.global_timeout = parseInt(config.global_timeout, 10);
    if (config.global_timeout > 0) {
        process.setAllRequestsTimeout(config.global_timeout);
    }

    config.inc_req_timeout = parseInt(config.inc_req_timeout, 10);
    if (config.inc_req_timeout > 0) {
        process.setIncomingRequestsTimeout(config.inc_req_timeout);
    }

    config.out_req_timeout = parseInt(config.out_req_timeout, 10);
    if (config.out_req_timeout > 0) {
        process.setOutgoingRequestsTimeout(config.out_req_timeout);
    }

}

/*
 * Instruments request for timeouts
 */
function instrumentReq(config, req, resp) {
    var closer,
        timeout;

    config.idle_timeout = parseInt(config.idle_timeout, 10);
    if (config.idle_timeout > 0) {
        if (req.socket) {
            req.socket.setTimeout(config.idle_timeout);
        } else if (req.connection && req.connection.socket) {
            req.connection.socket.setTimeout(config.idle_timeout);
        }
    }

    config.inc_req_timeout = parseInt(config.inc_req_timeout, 10);
    // "incoming_timeout" deprecated, since it was never documented
    config.incoming_timeout = parseInt(config.incoming_timeout, 10);
    // sets the timeout on the request
    timeout = config.inc_req_timeout || config.incoming_timeout || globalIncoming;
    if (timeout) {
        closer = new Closer(resp, timeout);
        resp.on('finish', function() {
            closer.remove();
        });
        resp.on('close', function() {
            closer.remove();
        });
    }
}

/*
 * Set Socket NoDelay to true (only for incoming requests!)
 */
function setNoDelay(conf, req) {
    var socket;
    if (conf.socket_no_delay) {
        socket = req.connection && req.connection.socket ? req.connection.socket : req.socket;
        socket.setNoDelay(true);
    }
}

/*
 * Sets whether socketNoDelay should be set on all outgoing ClientRequests
 */
function setClientRequestNoDelay(conf) {
    globalNoDelayFlag = !!conf.socket_no_delay;
}


/*
 * Sets the maxSockects
 */
function setDefaultMaxSockets(conf) {
    conf.max_sockets = parseInt(conf.max_sockets, 10);
    if (conf.max_sockets > 0) {
        http.globalAgent.maxSockets = conf.max_sockets;
    }
}

module.exports = function node_limits_init(config) {
    if (config && (config.enable === "true" || config.enable === true)) {
        globalOutgoing = 0;
        globalIncoming = 0;

        exposeGlobalTimers(config);
        //set MaxSocket at module load time coz its used for http client request
        setDefaultMaxSockets(config);
        setClientRequestNoDelay(config);
    }

    return function node_limits(req, resp, next) {
        var count = null,
            conf = (req.mod_config) ? mergeConfig(config, req.mod_config) : config,
            reqEmit = req.emit;

        if (!conf || (conf.enable !== "true" && conf.enable !== true)) {
            next();
            return;
        }

        if (typeof conf.post_max_size === "string") {
            conf.post_max_size = parseInt(conf.post_max_size, 10);
        }

        if (typeof conf.uri_max_length === "string") {
            conf.uri_max_length = parseInt(conf.uri_max_length, 10);
        }

        if (conf.uri_max_length > 0 && req.url.length > conf.uri_max_length ) {
            resp.writeHead(413, 'Request-URI Too Long', {'Content-Type': 'text/plain'});
            resp.end('413 Request-URI Too Long');
            return;
        }

        //Set it again since a incoming request can have a different config value for max-socket
        setDefaultMaxSockets(conf);
        setClientRequestNoDelay(conf);
        setNoDelay(conf, req);

        instrumentReq(conf, req, resp);

        // Wrapping req.emit. Will be called when
        // client calls req.on('data'
        req.emit = function node_limits_emit(eventName, data) {

            if (eventName === 'data') {

                if (data instanceof Buffer) {
                    count += data.length;
                } else if (typeof data === "string") {
                    var encoding = (req._decoder && req._decoder.encoding) ?  req._decoder.encoding : 'utf8';
                    count += Buffer.byteLength(data, encoding);
                }

                if ((conf.post_max_size > 0 && count > conf.post_max_size) || (conf.file_uploads !== "true" && conf.file_uploads !== true)) {

                    if (!resp.headersSent) {  // since node-v0.9.3
                        if (req.socket) {
                            req.socket.setNoDelay(true);
                        } else if (req.connection && req.connection.socket) {
                            req.connection.socket.setNoDelay(true);
                        }

                        // write response
                        resp.writeHead(413, 'Request Entity Too Large', {'Content-Type': 'text/plain'});
                        resp.end('413 Request Entity Too Large');
                    }
                    //  Forward all events to original emitter
                    reqEmit.call(req, 'error', 'Request Entity Too Large');
                    req._hadError = true;

                    // stops the socket, so the data stream stops
                    if (req.socket) {
                        req.socket.pause();
                        // allow socket to flush
                        setTimeout(function () {
                            if (req.socket) {
                                req.socket.destroySoon();
                            }
                        });
                    } else if (req.connection) {
                        req.connection.pause();
                        setTimeout(function () {
                            if (req.connection) {
                                req.connection.destroySoon();
                            }
                        });
                    }
                }
            }

            //  Forward all events to client
            reqEmit.apply(req, arguments);
        };

        next();
    };
};
module.exports.__Unit_Closer = Closer;
