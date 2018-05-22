var mod_limits = require('../lib/index.js');

var assert = require('assert');
var sinon = require('sinon');
var http = require('http');
var async = require('async');
var url = require('url');

var kPort = process.env.PORT || 8888;

describe('node-limits functional', function() {
    var self = this;

    // Set up a server which responds with 200 OK after a URL-param derived latency
    before(function() {
        var app = function(req, res) {
            var uri = url.parse(req.url, true);
            var latency = uri.query.latency || 0;

            req.resume()
                .on('end', function() {
                    setTimeout(function() {
                        res.writeHead(200, 'OK');
                        res.end();
                    }, latency);
                });
        };
        self.server = http.createServer(app).listen(kPort);
    });

    after(function() {
        self.server.close();
    });

    // regression test for case where later versions of node set socket._httpMessage = NULL
    // before calling node_limits_free handler
    // If this case reoccurs, symptoms are usually that sockets/requests are closed/aborted even
    // though the request had long since completed

    it('allows consecutive keepalive ClientRquests where sum(elapsed time) > out_req_timeout', function(done) {
        var kLatency = 3;
        var kNumRequests = 10;

        var testee = mod_limits({'enable': true,
                                 'out_req_timeout': (kNumRequests-2) * kLatency});

        var agent = new http.Agent({keepAlive: true, maxSockets: 4, maxFreeSockets: 2});

        // Make multiple consecutive requests, each one taking kLatency milliseconds
        // such that kLatency << out_req_timeout, but kNumRequests * kLatency > out_req_timeout
        async.timesSeries(kNumRequests, function(i, next) {
            var rq = { emit: sinon.fake() };
            var rs = { write: sinon.fake(), writeHead: sinon.fake(), end: sinon.fake() };

            // Emulate node-limits middleware running on each incoming request
            // where it monkey patches and sets various timeouts for outgoing ClientRquests
            testee(rq, rs, function(err) {
                if (err) { assert.ifError(err); }
                (function handle(rq, rs) {
                    var opts = {
                        hostname: 'localhost',
                        port: kPort,
                        path: '/?latency=' + kLatency,
                        agent: agent
                    };
                    var req = http.request(opts, function (res) {
                        res.resume().
                            on('end', function() {
                                next(null, req);
                            });
                    }).on('error', function(e) {
                        next(e, req);
                    }).on('abort', function(e) {
                        next(e, req);
                    });

                    req.end();
                })(rq, rs);

            });
        }, function(err, reqs) {
            agent.destroy();
            done(err);
        });
    });

});  // describe

