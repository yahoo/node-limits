var mod_limits = require('../lib/index.js');

var net = require('net'),
    http = require('http'),
    events = require('events'),
    util = require('util');

var assert = require('assert'),
    sinon = require('sinon');

var nodeVersion = Number(process.versions.node.match(/^(\d+\.\d+)/)[1]);

function getReq(arr) {
    return {
        url : "www.yahoo.com",
        headers : arr ? [["content-type", "text/plain"], ["host", "www.yahoo.com"]]
        :({ "content-type" : "text/plain",
                "host" : "www.yahoo.com"
            }),
        method : 'GET',
        agent : {
            addRequest : function() {
            }
        },
        emit : sinon.fake.returns(42)
    };
}

function getResp() {
    return {
        status : 0,
        headers : null,
        blob : "",
        write : function (data) {
            this.blob += data;
        },
        writeHead : function(stat) {
            this.status = stat;
            this.headers = (typeof arguments[1] !== "string") ? arguments[1] : arguments[2];
        },
        end : function (data) {
            this.blob += data;
        }
    };
}

function getSocket() {
    var s = new events.EventEmitter;
    Object.assign(s, {
        setNoDelay: function() { return 0; },
        destroy: function() {},
        setTimeout: function() { return 0; },
        pause: function() { return 0; },
        destroySoon: function() { return 0; }});
    s.onceSpy = sinon.spy(s, 'once');
    s.onSpy = sinon.spy(s, 'on');
    if (nodeVersion >= 6.0) { s.prependOnceListenerSpy = sinon.spy(s,'prependOnceListener'); }
    return s;
}

describe('node-limits', function() {
    describe('works as middleware', function() {
        var self = this;

        beforeEach(function() {
            self.req = getReq();
            self.resp = getResp();
        });

        it('calls callback whether enabled or disabled', function() {
            var testee1 = mod_limits({'enabled': true}),
                testee2 = mod_limits({'enabled': false});

            var callback1 = sinon.fake(),
                callback2 = sinon.fake();
            testee1(self.req, self.resp, callback1);
            assert(callback1.calledOnce);

            testee2(self.req, self.resp, callback2);
            assert(callback2.calledOnce);
        });

        it('defaults to disabled with null config', function() {
            var testee = mod_limits();

            var callback = sinon.fake();
            var origFn = sinon.fake.returns(42);
            self.req.emit = origFn;
            testee(self.req, self.resp, callback);

            // Check that when not enabled, req.emit is unchanged
            assert.strictEqual(42, self.req.emit.call(null, 'dummy'));
            assert.strictEqual(origFn, self.req.emit);
        });

        it('when enabled, hooks a new req.emit function', function() {
            var testee = mod_limits({"enable": true});

            var origFn = self.req.emit;
            var callback = sinon.fake();

            testee(self.req, self.resp, callback);

            // Check that when enabled, req.emit is changed
            assert.notStrictEqual(42, self.req.emit.call(null, 'dummy'));
            assert.notStrictEqual(origFn, self.req.emit);
        });

        it('allows config to be overridden on a per-request basis', function() {
            var testee = mod_limits({
                "enable": false,
                "file_uploads": true,
                "post_max_size": 1000
            });

            var callback = sinon.fake();

            self.req.mod_config = {
                "enable": true
            };

            var origFn = sinon.fake.returns(42);
            self.req.emit = origFn;
            testee(self.req, self.resp, callback);

            // Check that when enabled, req.emit is monkeypatched
            assert.notStrictEqual(42, self.req.emit.call(null, 'dummy'));
            assert.notStrictEqual(origFn, self.req.emit);
        });
    });

    describe('correctly implements limits on request body and file uploads', function() {
        var self = this;

        beforeEach(function() {
            self.req = getReq();
            self.resp = getResp();
            self.socket = getSocket();
        });

        it('sets response code to 413 if request exceeds post_max_size', function() {
            var testee = mod_limits({
                "enable": true,
                "file_uploads": true,
                "post_max_size": 1000
            });

            var callback = sinon.fake();

            testee(self.req, self.resp, callback);

            self.req.emit.call(null, 'data', new Buffer(500));
            assert.strictEqual(self.resp.status, 0);

            self.req.emit.call(null, 'data', new Buffer(600));
            assert.strictEqual(self.resp.status, 413);
        });

        it('sets response code to 413 if request consists of a string > post_max_size', function() {
            var testee = mod_limits({
                "enable": true,
                "file_uploads": true,
                "post_max_size": 1000
            });

            var longString = "",
                extraLongString = "",
                i = 0;
            var callback = sinon.fake(),
                emitter = sinon.spy();

            for (i=0; i < 50; i++) {
                longString += "0123456789";  // 500 characters
            }
            for (i=0; i < 60; i++) {
                extraLongString += "0123456789";  // 600 characters
            }

            self.req.emit = emitter;

            testee(self.req, self.resp, callback);

            self.req.emit.call(null, 'data', longString);
            assert.strictEqual(self.resp.status, 0);

            self.req.emit.call(null, 'data', extraLongString);
            assert.strictEqual(self.resp.status, 413);

            assert(emitter.calledWith('error', 'Request Entity Too Large'));
        });

        it('can disable uploads completely', function() {
            var testee = mod_limits({
                "enable": true,
                "file_uploads": false
            });

            var callback = sinon.fake(),
                emitter = sinon.spy();

            self.req.emit = emitter;

            testee(self.req, self.resp, callback);

            // Request is trying to upload some data
            self.req.emit.call(self.req, 'data', '1');
            assert.strictEqual(self.resp.status, 413);

            assert(emitter.calledWith('error', 'Request Entity Too Large'));
        });

        it('sends back a 413 response directly when response has yet to begin', function() {
            var testee = mod_limits({
                "enable": true,
                "file_uploads": false
            });

            var callback = sinon.fake();

            self.resp.headersSent = false;
            self.resp.writeHead = sinon.spy(self.resp, 'writeHead'),
            self.resp.end = sinon.spy(self.resp, 'end');

            testee(self.req, self.resp, callback);

            // Request is trying to upload some data
            self.req.emit.call(self.req, 'data', '1');

            assert(self.resp.writeHead.calledOnceWith(413));
            assert(self.resp.end.calledOnce);
            assert(self.resp.writeHead.calledBefore(self.resp.end));
        });

        it('omits any response if response headers have already been sent', function() {
            var testee = mod_limits({
                "enable": true,
                "file_uploads": false
            });

            var callback = sinon.fake(),
                writeHeadSpy = sinon.spy(self.resp, 'writeHead'),
                endSpy = sinon.spy(self.resp, 'end');

            self.resp.headersSent = true;
            self.resp.writeHead = writeHeadSpy;
            self.resp.end = endSpy;

            testee(self.req, self.resp, callback);

            // Request is trying to upload some data
            self.req.emit.call(self.req, 'data', '1');

            assert(self.resp.writeHead.notCalled);
            assert(self.resp.end.notCalled);
        });

        it('always emits "error" event on request object', function() {
            var testee = mod_limits({
                "enable": true,
                "file_uploads": false
            });

            var callback = sinon.fake(),
                reqEmitter = sinon.fake();

            self.req.emit = reqEmitter;

            testee(self.req, self.resp, callback);

            // Request is trying to upload some data
            self.req.emit.call(self.req, 'data', '1');

            assert(reqEmitter.calledWith('error'));
        });

        it('stop incoming data and destroy request socket when there\'s an error', function(done) {
            var testee = mod_limits({
                "enable": true,
                "file_uploads": false
            });
            var socket = self.socket;

            var callback = sinon.fake();

            socket.pause = sinon.spy(socket, "pause");
            socket.destroySoon = sinon.spy(socket, "destroySoon");
            self.req.socket = socket;

            testee(self.req, self.resp, callback);

            // Request is trying to upload some data
            self.req.emit.call(self.req, 'data', '1');

            assert(socket.pause.calledOnce);
            setTimeout(function() {
                assert(socket.destroySoon.calledOnce);
                assert(socket.pause.calledBefore(socket.destroySoon));
                done();
            }, 1);
        });
    });

    describe('correctly enforces incoming request timeouts', function() {
        var self = this;

        beforeEach(function() {
            self.req = getReq();
            self.resp = getResp();
            self.socket = getSocket();
        });

        it('sends 504 response for global timeout on incoming requests', function(done) {
            var testee = mod_limits({
                "enable": true,
                "global_timeout": 1
            });
            var resp = new http.ServerResponse(self.req),
                writeHeadSpy = sinon.spy(resp, 'writeHead'),
                endSpy = sinon.spy(resp, 'end');

            testee(self.req, resp, function() {});

            setTimeout(function() {
                assert(writeHeadSpy.calledOnceWith(504, 'Gateway Timeout'));
                assert(endSpy.calledOnce);
                assert(writeHeadSpy.calledBefore(endSpy));
                done();
            }, 2);
        });

        it('sends status 504 response for inc_req_timeout if response headers unsent', function(done) {
            var testee = mod_limits({
                "enable": true,
                "inc_req_timeout": 1
            });
            var resp = new http.ServerResponse(self.req),
                writeHeadSpy = sinon.spy(resp, 'writeHead'),
                endSpy = sinon.spy(resp, 'end');

            testee(self.req, resp, function() {});

            setTimeout(function() {
                assert(writeHeadSpy.calledOnceWith(504, 'Gateway Timeout'));
                assert(endSpy.calledOnce);
                assert(writeHeadSpy.calledBefore(endSpy));
                done();
            }, 2);
        });

        it('sends 504 in body of response if response headers already sent', function(done) {
            var testee = mod_limits({
                "enable": true,
                "inc_req_timeout": 1
            });
            var resp = new http.ServerResponse(self.req),
                writeHeadSpy = sinon.spy(resp, 'writeHead'),
                endSpy = sinon.spy(resp, 'end');

            testee(self.req, resp, function() {});

            resp.writeHead(200, 'OK');
            setTimeout(function() {
                assert(writeHeadSpy.calledOnceWith(200, 'OK'));
                assert(endSpy.calledOnceWith('504 Gateway Timeout'));
                resp.emit('finish');  // called when response is ended
                done();
            }, 2);
        });

        it('passes if matching response completes inside inc_req_timeout', function(done) {
            var testee = mod_limits({
                "enable": true,
                "inc_req_timeout": 8
            });
            var resp = new http.ServerResponse(self.req),
                writeHeadSpy = sinon.spy(resp, 'writeHead'),
                endSpy = sinon.spy(resp, 'end');

            testee(self.req, resp, function() {});

            process.nextTick(function() {
                resp.writeHead(200, 'OK');
                resp.end('ok');
                resp.emit('finish');  // have to manually do this since we don't have a socket
            });

            setTimeout(function() {
                assert(resp.finished);
                assert(writeHeadSpy.neverCalledWith(504, 'Gateway Timeout'));
                assert(writeHeadSpy.calledWith(200, 'OK'));
                assert(endSpy.calledOnceWith('ok'));
                done();
            }, 10);
        });

        it('sets request socket timeout when idle_timeout is set', function() {
            var testee = mod_limits({
                "enable": true,
                "idle_timeout": 1
            });
            var socket = self.socket,
                req = new http.IncomingMessage(socket),
                resp = new http.ServerResponse(req),
                setTimeoutSpy = sinon.spy(socket, 'setTimeout');

            testee(req, resp, function() {});
            assert(setTimeoutSpy.calledWith(1));
            resp.emit('finish');
        });
    });  // end of describe

    describe('correctly enforces outgoing request timeouts', function() {
        var self = this;

        beforeEach(function() {
            self.req = getReq();
            self.resp = getResp();
            self.socket = getSocket();
        });

        it('aborts the ClientRequest if global_timeout exceeded before response', function(done) {
            var testee = mod_limits({
                "enable": true,
                "global_timeout": 3
            });
            var socket = self.socket,
                req = new http.ClientRequest({ path: '/client', 'createConnection': sinon.fake.returns(socket) }),
                resp = new http.ServerResponse(req),
                reqAbort = sinon.spy(req, 'abort'),
                onErrorSpy = sinon.spy();

            // N.B. req.on('error',cb) is called twice.  Once from node-limits, but also
            // once from the _http_client.js library code in nodejs which emits
            // an error when the socket hangs up before any response has been received
            req.on('error', onErrorSpy);

            testee(req, resp, function() {});

            req.end();

            setTimeout(function() {
                assert(reqAbort.called);
                assert(onErrorSpy.called);
                socket.emit('free');
                resp.emit('close');  // clean up
                done();
            }, 6);
        });

        it('aborts the ClientRequest if out_req_timeout exceeded before response', function(done) {
            var testee = mod_limits({
                "enable": true,
                "out_req_timeout": 1
            });
            var socket = self.socket,
                req = new http.ClientRequest({ 'createConnection': sinon.fake.returns(socket) }),
                resp = new http.ServerResponse(req),
                reqAbort = sinon.spy(req, 'abort'),
                onErrorSpy = sinon.spy();

            // N.B. req.on('error' is called twice.  Once from node-limits, but also
            // once from the _http_client.js library code in nodejs which emits
            // an error when the socket hangs up before any response has been received
            req.on('error', onErrorSpy);
            testee(req, resp, function() {});
            
            setTimeout(function() {
                assert(reqAbort.called);
                assert(onErrorSpy.called);
                resp.emit('close');
                socket.emit('free');
                done();
            }, 3);
        });

        it('allows ClientRequest if response completes before out_req_timeout', function(done) {
            var testee = mod_limits({
                "enable": true,
                "out_req_timeout": 5
            });

            var socket = self.socket,
                req = new http.ClientRequest({ 'createConnection': sinon.fake.returns(socket) }),
                resp = new http.IncomingMessage(req),
                reqAbort = sinon.spy(req, 'abort'),
                onResponseSpy = sinon.spy();

            req.on('error', sinon.fake());
            req.on('response', onResponseSpy);

            testee(req, resp, function() {});
            req.end();

            process.nextTick(function() {
                // simulating ending the response and freeing the socket
                req.emit('response', resp);
                resp.emit('finish');  // a successful response emits "finish"
                socket.emit('free');
            });

            setTimeout(function() {
                assert(reqAbort.notCalled);
                assert(onResponseSpy.calledOnce);
                done();
            }, 3);
        });

    });  // describe

    describe('Enforces other limits', function() {
        var self = this;

        beforeEach(function() {
            self.req = getReq();
            self.resp = getResp();
            self.socket = getSocket();
        });

        it('returns 413 if incoming request URI length exceeds configured max size', function() {
            var testee = mod_limits({
                "enable": true,
                "uri_max_length": 20
            });

            self.resp.writeHead = sinon.spy(self.resp, 'writeHead'),
            self.resp.end = sinon.spy(self.resp, 'end');

            self.req.url = "012345678901234567890";
            testee(self.req, self.resp, function() {});

            assert(self.resp.writeHead.calledOnceWith(413));
            assert(self.resp.end.calledOnce);
            assert(self.resp.writeHead.calledBefore(self.resp.end));
        });

        it('allows incoming request when URI length is less than max size', function() {
            var testee = mod_limits({
                "enable": true,
                "uri_max_length": 20
            });

            self.resp.writeHead = sinon.spy(self.resp, 'writeHead'),
            self.resp.end = sinon.spy(self.resp, 'end');

            self.req.url = "0123456789012345678";
            testee(self.req, self.resp, function() {});

            assert(self.resp.writeHead.notCalled);
            assert(self.resp.end.notCalled);
        });

        it('calls socket.setNoDelay on incoming request (?) when configured', function() {
            // This seems pretty useless.  It would be more useful to call setNoDelay
            // on outgoing ClientRequests rather than IncomingRequests!
            var testee = mod_limits({
                "enable": true,
                "socket_no_delay": true
            });

            var socket = self.socket,
                setNoDelaySpy = sinon.spy(socket, 'setNoDelay');

            self.req.socket = socket;
            testee(self.req, self.resp, function() {});

            assert(setNoDelaySpy.calledOnceWith(true));
        });

        it('calls socket.setNoDelay on outgoing ClientRequest when configured', function() {
            // N.B. The current implementation will not work on a per-request mod_config
            // basis. It can only be set once at module initialization time.
            var testee = mod_limits({
                "enable": true,
                "socket_no_delay": true
            });

            var socket = self.socket,
                setNoDelaySpy = sinon.spy(socket, 'setNoDelay'),
                req = new http.ClientRequest({ 'createConnection': sinon.fake.returns(socket) });

            req.on('error', sinon.fake());
            req.socket = socket;
            testee(req, self.resp, function() {});
            req.onSocket(socket);

            assert(setNoDelaySpy.calledWith(true));
            socket.emit('free');
        });

        it('do not set socket.setNoDelay on ClientRequest unless configured', function() {
            var testee = mod_limits({
                "enable": true,
                "socket_no_delay": false
            });

            var socket = self.socket,
                setNoDelaySpy = sinon.spy(socket, 'setNoDelay'),
                req = new http.ClientRequest({ 'path': '/donodelay', 'createConnection': sinon.fake.returns(socket) });

            req.on('error', sinon.fake());
            req.socket = socket;
            testee(self.req, self.resp, function() {});
            req.onSocket(socket);

            assert(setNoDelaySpy.notCalled);
            socket.emit('free');
        });

        it('http.globalAgent maxSockets is set when configured', function() {
            // Note: this has a limitation that it works only for the globalAgent
            // and only for http.  For anyone using https, you are best to create your own
            // userAgent and configure it correctly
            http.globalAgent.maxSockets = 10;
            var testee = mod_limits({
                "enable" : "true",
                "max_sockets" : 0
            });
            assert.strictEqual(10, http.globalAgent.maxSockets);

            testee = mod_limits({
                "enable" : "true",
                "max_sockets" : 100
            });
            assert.strictEqual(100, http.globalAgent.maxSockets);

            self.req.mod_config = {
                "max_sockets" : 1000
            };

            testee(self.req, self.resp, function() {} );

            assert.strictEqual(1000, http.globalAgent.maxSockets);

            // Another case where per request modification doesn't make sense
            // since the max # of sockets is specified on a globalAgent and any
            // subsequent incoming request (which is almost certainly concurrent
            // with the prior request) will always reset it to the default
            delete self.req.mod_config;

            testee(self.req, self.resp, function() {} );

            assert.strictEqual(100, http.globalAgent.maxSockets);
        });

        it('Closer.remove() works',  function() {
            var testee = mod_limits({
                "enable": true
            });
            // never seems to be used however
            var socket = self.socket,
                outreq = self.req,
                closer = new mod_limits.__Unit_Closer(outreq, 2);

            assert.strictEqual(outreq.__closer, closer);
            closer.remove();
            assert(!outreq.__closer);
            delete closer;
        });


    });  // describe

});

