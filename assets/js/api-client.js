/**
 * api-client.js — Authenticated API client for the BotW Unexplored Area Viewer
 *
 * Exposes window.BotWApi with authenticated fetch wrappers for all server
 * state endpoints. The API key is fetched once from /api/config and cached
 * for the lifetime of the page.
 *
 * All methods return a Promise that resolves to the parsed JSON response,
 * or null if the request fails (network error, server unavailable, etc.).
 */
(function () {
    var _apiKey = null;
    var _apiKeyPromise = null;

    function getApiKey() {
        if (_apiKeyPromise) return _apiKeyPromise;
        _apiKeyPromise = fetch('/api/config')
            .then(function (r) {
                return r.json();
            })
            .then(function (data) {
                _apiKey = data.apiKey || null;
                return _apiKey;
            })
            .catch(function () {
                return null;
            });
        return _apiKeyPromise;
    }

    function authFetch(method, path, body) {
        return getApiKey()
            .then(function (key) {
                var opts = {
                    method: method,
                    headers: { 'Content-Type': 'application/json' }
                };
                if (key) opts.headers['X-API-Key'] = key;
                if (body !== undefined) opts.body = JSON.stringify(body);
                return fetch(path, opts).then(function (r) {
                    return r.json();
                });
            })
            .catch(function () {
                return null;
            });
    }

    function debounce(fn, ms) {
        var t;
        return function () {
            var args = arguments;
            clearTimeout(t);
            t = setTimeout(function () {
                fn.apply(null, args);
            }, ms);
        };
    }

    window.BotWApi = {
        get: function (path) {
            return authFetch('GET', path);
        },
        patch: function (path, body) {
            return authFetch('PATCH', path, body);
        },
        post: function (path, body) {
            return authFetch('POST', path, body);
        },
        delete: function (path, body) {
            return authFetch('DELETE', path, body);
        },
        put: function (path, body) {
            return authFetch('PUT', path, body);
        },
        debounce: debounce
    };
})();
