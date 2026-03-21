/**
 * api-client.js — API client for the BotW Unexplored Area Viewer
 *
 * Exposes window.BotWApi with fetch wrappers for all server state endpoints.
 */
(function () {
    function apiFetch(method, path, body) {
        var opts = { method: method, headers: { 'Content-Type': 'application/json' } };
        if (body !== undefined) opts.body = JSON.stringify(body);
        return fetch(path, opts)
            .then(function (r) { return r.json(); })
            .catch(function () { return null; });
    }

    function debounce(fn, ms) {
        var t;
        return function () {
            var args = arguments;
            clearTimeout(t);
            t = setTimeout(function () { fn.apply(null, args); }, ms || 500);
        };
    }

    window.BotWApi = {
        get:    function (path)       { return apiFetch('GET',    path); },
        patch:  function (path, body) { return apiFetch('PATCH',  path, body); },
        post:   function (path, body) { return apiFetch('POST',   path, body); },
        delete: function (path, body) { return apiFetch('DELETE', path, body); },
        put:    function (path, body) { return apiFetch('PUT',    path, body); },
        debounce: debounce
    };
})();
