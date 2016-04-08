/**
 * This behaves like a WebSocket in every way, except if it fails to connect,
 * or it gets disconnected, it will repeatedly poll until it succesfully connects
 * again.
 *
 * It is API compatible, so when you have:
 *   ws = new WebSocket('ws://....');
 * you can replace with:
 *   ws = new ReconnectingWebSocket('ws://....');
 *
 * The event stream will typically look like:
 *  onconnecting
 *  onopen
 *  onmessage
 *  onmessage
 *  onclose // lost connection
 *  onconnecting
 *  onopen  // sometime later...
 *  onmessage
 *  onmessage
 *  etc...
 *
 * It is API compatible with the standard WebSocket API.
 *
 * Latest version: https://github.com/joewalnes/reconnecting-websocket/
 * - Joe Walnes
 */
function ReconnectingWebSocketProvider($timeout) {

  var ReconnectingWebSocket = function (url, protocols) {
    protocols = protocols || [];

    // These can be altered by calling code.
    this.debug = false;

    // how long to wait before considering connecting to be impossible
    this.timeoutInterval = 2000;

    // initial wait between reconnection attempts
    this.reconnectInterval = this.initialReconnectInterval = 5000;

    // maximum wait between attempts. Continue to space reconnections until
    // they're five minutes apart.
    this.maxReconnectInterval = 5 * 60 * 1000;

    // internal counter of reconnection attempts so far
    var retries = 0;

    this.url = url;
    this.protocols = protocols;
    this.URL = url; // Public API

    // callbacks, should be overridden if needed
    this.onopen = function() { };
    this.onclose = function() { };
    this.onconnecting = function() { };
    this.onmessage = function() { };
    this.onerror = function() { };

    // custom callback, not present in WebSocket, let browser know a reconnection attempt is coming.
    this.onreconnect = function () {};

    // internal vars
    var ws;
    var forcedClose = false;
    var timedOut = false;

    // handle this inside local functions
    var self = this;

    var dbg = function () {
      if (self.debug || ReconnectingWebSocket.debugAll) {
        var args = Array.prototype.slice.call(arguments);
        args.unshift('[ReconnectingWebSocket]')
        console.debug.apply(console, args);
      }
    }

    var resetReconnectInterval = function () {
      dbg('resetting reconnection interval');
      retries = 0;
      self.reconnectInterval = self.initialReconnectInterval;
    }

    // modify reconnectInterval in place
    var updateReconnectInterval = function () {
      // http://dthain.blogspot.com/2009/02/exponential-backoff-in-distributed.html
      //
      // delay = MIN( R * T * F ^ N , M )
      //
      //   R should be a random number in the range [1-2], so that its
      //     effect is to spread out the load over time, but always more
      //     conservative than plain backoff.
      //
      //   T is the initial timeout, and should be set at the outer limits
      //     of expected response time for the service. For example, if your
      //     service responds in 1ms on average but in 10ms for 99% of
      //     requests, then set t=10ms.
      //
      //   F doesn't matter much, so choose 2 as a nice round number. (It's
      //     the exponential nature that counts.)
      //
      //   N is the current number of retries
      //
      //   M should be as low as possible to keep your customers happy, but
      //     high enough that the system can definitely handle requests from
      //     all clients at that sustained rate.
      //

      var R = Math.random() + 1,
          T = self.initialReconnectInterval,
          F = 2,
          N = retries,
          M = self.maxReconnectInterval;

      dbg('updating reconnectInterval with', R, T, F, N, M);

      self.reconnectInterval = Math.min(R * T * Math.pow(F, N), M);
      dbg('reconnectInterval updated', self.reconnectInterval, 'attempt', retries);
      retries++;
    }

    // open a new connection
    var connect = function (reconnectAttempt) {
      ws = new WebSocket(url, protocols);
      self.readyState = ws.readyState;

      // connection is opening, tell public api
      self.onconnecting();

      dbg('attempt to connect', url);

      var localWs = ws;

      // force close event if failed to connect after self.timeoutInterval milliseconds
      var timeout = setTimeout(function() {
        dbg('connection timeout', url);

        // flag this close event as being a locally forced timeout
        timedOut = true;
        localWs.close();
        timedOut = false;

      }, self.timeoutInterval);

      ws.onopen = function(event) {
        dbg('ws.onopen', url);

        self.readyState = ws.readyState;

        // cancel failure to connect timeout
        clearTimeout(timeout);

        // success! reconnection happened, so we cleanup after ourselves
        resetReconnectInterval();

        reconnectAttempt = false;
        $timeout(function(){
          self.onopen(event);
        });
      };

      ws.onclose = function(event) {
        dbg('ws.onclose');

        self.readyState = ws.readyState;

        // cancel the local reconnect timeout if socket closed (or failed to
        // open) before the timeout triggered
        clearTimeout(timeout);

        ws = null;
        if (forcedClose) {
          // forced closure, DO NOT RETRY
          self.onclose(event);
        } else {
          // do retry

          // override WebSocket readyState
          self.readyState = WebSocket.CONNECTING;

          // trigger public onconnecting
          $timeout(function(){
            self.onconnecting();
          });

          // if this is not a recursive reconnection call or a timeout, trigger public onclose
          if (!(reconnectAttempt || timedOut)) {
            dbg('onclose', url);
            $timeout(function(){
              self.onclose(event);
            });
          }

          // + 1 to include the original connection
          $timeout(function(){
            self.onreconnect(retries + 1, self.reconnectInterval);
          });

          // and attempt a reconnection after reconnectInterval
          setTimeout(function() {
            connect(true);
            updateReconnectInterval();
          }, self.reconnectInterval);
        }
      };

      ws.onmessage = function(event) {
        dbg('ws.onmessage', url, event.data);
        $timeout(function(){
          self.onmessage(event);
        });
      };

      ws.onerror = function(event) {
        // don't do anything on an error, just report it
        dbg('ws.onerror', url, event);
        $timeout(function(){
          self.onerror(event);
        });
      };
    }

    // immediately attempt to connect to the given websocket URL
    connect(url);

    this.send = function(data) {
      if (ws) {
        dbg('this.send', url, data);
        return ws.send(data);
      } else {
        throw new Error('INVALID_STATE_ERR : Pausing to reconnect websocket');
      }
    };

    // force closure of the ReconnectingWebSocket
    this.close = function() {
      forcedClose = true;
      if (ws) {
        ws.close();
      }
    };

    // force immediate reconnection attempt, even if we're pausing
    this.refresh = function() {
      if (ws) {
        ws.close();
      }
    };
  }
  return ReconnectingWebSocket;
};
