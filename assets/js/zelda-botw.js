/**
 * zelda-botw.js — Main application logic for the BotW Unexplored Area Viewer
 *
 * Built on the save game editor framework by Marc Robledo (2017–2018).
 * Extended by Xanderphillips to add:
 *   - Auto-loading of the save file from the Express server
 *   - Interactive left sidebar with hover/click map highlighting
 *   - Player position marker with shrine interior detection
 *   - Player stats display (hearts, stamina, playtime, rupees, motorcycle)
 *   - Map pan and zoom with mouse wheel and middle-click drag
 *   - JS-positioned hover tooltips for all map icons
 *   - Polling-based auto-refresh when the save file changes (Manual Save only)
 */
var currentEditingItem = 0;
var locationValues = {};
var _saveHashMap = null;
var _dismissedWaypoints = { koroks: new Set(), locations: new Set() };
var _lastStateVersion = -1;
var _prevAppliedState = null;

var shrines = {};
var towers = {};
var divineBeasts = {};
var labos = {};
var remainingWarps = {};
var shrinesCompleted = 0;
var divineBeastsCompleted = 0;
var totalShrines = 0;
var totalTowers = 0;
var totalDivineBeasts = 0;
var totalShrineCompletions = 0;

var _knownVillages = [
    'Location_Hateno',
    'Location_Kakariko',
    'Location_Rito',
    'Location_Goron',
    'Location_Gerudo',
    'Location_Taura',
    'Location_UMiiVillage',
    'Location_WhiteZora',
    'Location_Cokiri'
];
var _knownSettlements = [
    'Location_AdeyaVillage',
    'Location_ChirakaVillage',
    'Location_GarakishiVillage',
    'Location_ShinyarkiVillage',
    'Location_TabantaVillage',
    'Location_RonronCity'
];
var _landmarkTypes = [
    'hatago',
    'village',
    'settlement',
    'great_fairy',
    'goddess',
    'castle',
    'shop_bougu',
    'shop_jewel',
    'shop_yorozu',
    'shop_color',
    'yadoya'
];

SavegameEditor = {
    Name: 'The legend of Zelda: Breath of the wild',
    Filename: 'game_data.sav',
    Version: 20190625,

    /* Constants */
    Constants: {
        MAX_ITEMS: 410,
        STRING_SIZE: 0x80,

        //missing versions: 1.1.1, 1.1.2 and 1.4.1
        VERSION: [
            'v1.0',
            'v1.1',
            'v1.2',
            'v1.3',
            'v1.3.1',
            'Kiosk',
            'v1.3.3',
            'v1.3.4',
            'v1.4',
            'v1.5',
            'v1.6',
            'v1.6*',
            'v1.6**',
            'v1.6***',
            'v1.5*',
            'v1.8'
        ],
        FILESIZE: [
            896976, 897160, 897112, 907824, 907824, 916576, 1020648, 1020648,
            1027208, 1027208, 1027216, 1027216, 1027216, 1027216, 1027248,
            1027248
        ],
        HEADER: [
            0x24e2, 0x24ee, 0x2588, 0x29c0, 0x2a46, 0x2f8e, 0x3ef8, 0x3ef9,
            0x471a, 0x471b, 0x471e, 0x0f423d, 0x0f423e, 0x0f423f, 0x471b, 0x4730
        ],

        MAP_ICONS: 0x9383490e,
        MAP_POS: 0xea9def3f,
        ICON_TYPES: {
            SWORD: 27,
            BOW: 28,
            SHIELD: 29,
            POT: 30,
            STAR: 31,
            CHEST: 32,
            SKULL: 33,
            LEAF: 34,
            TOWER: 35
        }
    },

    /* Offsets */
    Hashes: [0x8a94e07a, 'KOROK_SEED_COUNTER'],

    /* private functions */

    _buildHashMap: function () {
        _saveHashMap = {};
        for (var i = 0x0c; i < tempFile.fileSize - 4; i += 8) {
            var h = tempFile.readU32(i);
            if (!_saveHashMap.hasOwnProperty(h)) {
                _saveHashMap[h] = { offset: i, value: tempFile.readU32(i + 4) };
            }
        }
    },

    _searchHash: function (hash) {
        if (_saveHashMap && _saveHashMap.hasOwnProperty(hash)) return _saveHashMap[hash].offset;
        return -1;
    },

    _readFromHash: function (hash) {
        var offset = this._searchHash(hash);
        if (offset !== -1) return tempFile.readU32(offset + 4);
        return false;
    },
    _writeValueAtHash: function (hash, val) {
        var offset = this._searchHash(hash);
        if (offset !== -1) this._writeValue(offset + 4, val);
    },

    _getOffsets: function (v) {
        this.Offsets = {};
        var startSearchOffset = 0x0c;
        for (var i = 0; i < this.Hashes.length; i += 2) {
            for (var j = startSearchOffset; j < tempFile.fileSize; j += 8) {
                if (this.Hashes[i] === tempFile.readU32(j)) {
                    this.Offsets[this.Hashes[i + 1]] = j + 4;
                    startSearchOffset = j + 8;
                    break;
                }
            }
            /*if(typeof this.Offsets[this.Hashes[i+1]] === 'undefined'){
				console.log(this.Hashes[i+1]+' not found');
			}*/
        }
    },

    /* check if savegame is valid */
    _checkValidSavegameByConsole: function (switchMode) {
        var CONSOLE = switchMode ? 'Switch' : 'Wii U';
        tempFile.littleEndian = switchMode;
        for (var i = 0; i < this.Constants.FILESIZE.length; i++) {
            var versionHash = tempFile.readU32(0);

            if (
                tempFile.fileSize === this.Constants.FILESIZE[i] &&
                versionHash === this.Constants.HEADER[i] &&
                tempFile.readU32(4) === 0xffffffff
            ) {
                this._getOffsets(i);
                return true;
            } else if (
                tempFile.fileSize >= 896976 &&
                tempFile.fileSize <= 1500000 &&
                versionHash === this.Constants.HEADER[i] &&
                tempFile.readU32(4) === 0xffffffff
            ) {
                this._getOffsets(i);
                setValue(
                    'version',
                    this.Constants.VERSION[i] +
                        '<small>mod</small> (' +
                        CONSOLE +
                        ')'
                );
                return true;
            }
        }

        return false;
    },
    checkValidSavegame: function () {
        return (
            this._checkValidSavegameByConsole(false) ||
            this._checkValidSavegameByConsole(true)
        );
    },

    preload: function () {},

    /* load function */
    load: function () {
        tempFile.fileName = 'game_data.sav';
        this._buildHashMap();

        /* prepare viewer */

        locationValues.notFound = {
            koroks: {},
            locations: {},
            shrines: {},
            towers: {},
            divineBeasts: {}
        };

        locationValues.found = {
            koroks: 0,
            locations: 0,
            shrines: 0,
            towers: 0,
            divineBeasts: 0
        };

        // All Korok/Location Data filtered down to ones not found
        this._notFoundLocations(koroks, 'koroks');
        this._notFoundLocations(locations, 'locations');
        this._notFoundLocations(shrines, 'shrines');
        this._notFoundLocations(towers, 'towers');
        this._notFoundLocations(divineBeasts, 'divineBeasts');
        var completedIndices =
            this._getCompletedShrineIndices(shrineCompletions);
        shrinesCompleted = Object.keys(completedIndices).length;
        divineBeastsCompleted = this._countCompleted(divineBeastCompletions);

        renderStats(
            tempFile.readU32(this.Offsets.KOROK_SEED_COUNTER),
            shrinesCompleted,
            divineBeastsCompleted
        );

        this.drawKorokPaths(locationValues.notFound.koroks);

        // Split shrines: completed (yellow) trumps discovered (cyan)
        var _discoveredShines = {},
            _completedShrinesMap = {};
        for (var _sh in shrines) {
            if (!_saveHashMap[_sh] || !_saveHashMap[_sh].value) continue;
            var _idx = shrines[_sh].internal_name.replace(
                'Location_Dungeon',
                ''
            );
            if (completedIndices[_idx]) {
                _completedShrinesMap[_sh] = shrines[_sh];
            } else {
                _discoveredShines[_sh] = shrines[_sh];
            }
        }

        this.markMap(locationValues.notFound.locations, 'location');

        // Derive discovered locations (all locations minus not-found) and mark them.
        // Assign a location_type based on internal_name for icon selection.
        // Landmark types are always shown regardless of discovery state.
        var discoveredLocations = {};
        for (var _hash in locations) {
            var _loc = locations[_hash];
            var _type = 'checkpoint';
            var _n = _loc.internal_name;
            if (_n.indexOf('Hatago') !== -1) _type = 'hatago';
            else if (_knownVillages.indexOf(_n) !== -1) _type = 'village';
            else if (_knownSettlements.indexOf(_n) !== -1) _type = 'settlement';
            else if (_n.indexOf('WeaponCureSpring') !== -1)
                _type = 'great_fairy';
            else if (
                _n === 'Location_BraveFountain' ||
                _n === 'Location_PowerFountain' ||
                _n === 'Location_WisdomFountain'
            )
                _type = 'goddess';
            else if (_n.indexOf('Labo') !== -1) _type = 'labo';
            else if (_n.indexOf('Castle') !== -1) _type = 'castle';
            else if (_n.indexOf('ShopBougu') !== -1) _type = 'shop_bougu';
            else if (_n.indexOf('ShopJewel') !== -1) _type = 'shop_jewel';
            else if (_n.indexOf('ShopYorozu') !== -1) _type = 'shop_yorozu';
            else if (_n.indexOf('ShopColor') !== -1) _type = 'shop_color';
            else if (_n.indexOf('ShopYadoya') !== -1) _type = 'yadoya';

            var isLandmark = _landmarkTypes.indexOf(_type) !== -1;
            if (
                !locationValues.notFound.locations[_loc.internal_name] ||
                isLandmark
            ) {
                // Remove from notFound so landmarks don't also render as orange dots
                if (isLandmark)
                    delete locationValues.notFound.locations[
                        _loc.internal_name
                    ];
                discoveredLocations[_loc.internal_name] = {
                    display_name: _loc.display_name,
                    x: _loc.x,
                    y: _loc.y,
                    location_type: _type
                };
            }
        }
        this.markMap(discoveredLocations, 'location-discovered');
        // Set data-location-type on each discovered location waypoint for CSS icon selection
        for (var _dname in discoveredLocations) {
            var _el = document.getElementById(_dname);
            if (_el)
                _el.setAttribute(
                    'data-location-type',
                    discoveredLocations[_dname].location_type
                );
        }
        this.markMap(_discoveredShines, 'shrine');
        this.markMap(locationValues.notFound.shrines, 'shrine-not-activated');
        this.markMap(_completedShrinesMap, 'shrine-completed');
        this.markMap(towers, 'tower');

        // Split divine beasts: completed (green) vs. incomplete (red)
        var _completedDivineBeasts = {}, _incompleteDivineBeasts = {};
        for (var _db in divineBeasts) {
            var _dbName = divineBeasts[_db].internal_name.replace('Location_', '');
            var _isComplete = false;
            for (var _ch in divineBeastCompletions) {
                if (divineBeastCompletions[_ch].internal_name === 'Clear_' + _dbName) {
                    var _entry = _saveHashMap[_ch];
                    if (_entry && _entry.value) { _isComplete = true; break; }
                }
            }
            if (_isComplete) {
                _completedDivineBeasts[_db] = divineBeasts[_db];
            } else if (_saveHashMap[_db] && _saveHashMap[_db].value) {
                _incompleteDivineBeasts[_db] = divineBeasts[_db];
            }
        }
        this.markMap(_incompleteDivineBeasts, 'divine-beast');
        this.markMap(_completedDivineBeasts, 'divine-beast-completed');

        this.markMap(labos, 'labo');
        this.markMap(remainingWarps, 'warp');
        this.markMap(locationValues.notFound.koroks, 'korok');

        // Player position — three consecutive identical-hash pairs: [hash,X] [hash,Y] [hash,Z]
        var _pos = this._searchHash(0xa40ba103);
        if (_pos !== -1) {
            var playerX = tempFile.readF32(_pos + 4); // first  pair value = X (east/west)
            // _pos+8 = second hash, _pos+12 = Y (height) — skip
            var playerZ = tempFile.readF32(_pos + 20); // third pair value = Z (north/south)
            if (!isNaN(playerX) && !isNaN(playerZ)) {
                // When inside a shrine, position values are local interior coords.
                // Detect via MAP string and substitute the shrine's overworld coordinates.
                var _shrineCoords = getShrineOverworldCoords();
                if (_shrineCoords) {
                    placePlayerMarker(
                        _shrineCoords.x,
                        _shrineCoords.y,
                        'Player (In Shrine)'
                    );
                } else {
                    placePlayerMarker(playerX, playerZ);
                }
            }
        }

        // Player stats — each searched independently
        var _sh;
        _sh = this._searchHash(0x2906f327); // MAX_HEARTS — U32 quarter-heart units (÷4 = displayed hearts)
        if (_sh !== -1)
            setValue('span-stat-hearts', tempFile.readU32(_sh + 4) / 4);
        _sh = this._searchHash(0x3adff047); // MAX_STAMINA — stored as F32, units of 1/1000 wheel
        if (_sh !== -1) {
            var _sv = tempFile.readF32(_sh + 4);
            setValue(
                'span-stat-stamina',
                isNaN(_sv) ? '\u2014' : (_sv / 1000).toFixed(1)
            );
        }
        _sh = this._searchHash(0x73c29681); // PLAYTIME
        if (_sh !== -1)
            setValue(
                'span-stat-playtime',
                formatPlaytime(tempFile.readU32(_sh + 4))
            );
        _sh = this._searchHash(0x23149bf8); // RUPEES
        if (_sh !== -1)
            setValue(
                'span-stat-rupees',
                tempFile.readU32(_sh + 4).toLocaleString()
            );
        _sh = this._searchHash(0xc9328299); // MOTORCYCLE
        if (_sh !== -1)
            setMotorcycleIndicator(tempFile.readU32(_sh + 4) > 0);

        applyHiddenStates();
        applyServiceHiddenStates();
        _saveHashMap = null; // release after load completes — rebuilt on next load
    },

    // based on the load() method in https://github.com/marcrobledo/savegame-editors/blob/master/zelda-botw-master/zelda-botw-master.js
    _notFoundLocations: function (hashObjects, key = 'koroks') {
        for (var hash in hashObjects) {
            var entry = _saveHashMap[hash];
            if (!entry) continue;
            if (!entry.value) {
                var iname = hashObjects[hash].internal_name;
                var dSet =
                    key === 'koroks'
                        ? _dismissedWaypoints.koroks
                        : key === 'locations'
                          ? _dismissedWaypoints.locations
                          : null;
                if (dSet && dSet.has(iname)) {
                    locationValues.found[key]++;
                } else {
                    locationValues.notFound[key][iname] = {
                        display_name: hashObjects[hash].display_name,
                        x: hashObjects[hash].x,
                        y: hashObjects[hash].y,
                        offset: entry.offset
                    };
                }
            } else {
                locationValues.found[key]++;
            }
        }
    },

    // Count how many entries in hashObjects have a non-zero save flag
    _countCompleted: function (hashObjects) {
        var count = 0;
        for (var hash in hashObjects) {
            var entry = _saveHashMap[hash];
            if (entry && entry.value) count++;
        }
        return count;
    },

    // Returns an object mapping NNN → true for each Clear_DungeonNNN flag that is set
    _getCompletedShrineIndices: function (hashObjects) {
        var indices = {};
        for (var hash in hashObjects) {
            var entry = _saveHashMap[hash];
            if (entry && entry.value) {
                var idx = hashObjects[hash].internal_name.replace(
                    'Clear_Dungeon',
                    ''
                );
                indices[idx] = true;
            }
        }
        return indices;
    },

    // Mark the map with not found Koroks or Locations
    markMap(mapObjects, className) {
        var map = document.getElementById('map-container');
        var fragment = document.createDocumentFragment();

        for (var internal_name in mapObjects) {
            var waypoint = document.createElement('div');

            waypoint.classList.add('waypoint');
            waypoint.classList.add(className);
            waypoint.setAttribute(
                'style',
                'left: ' +
                    (3000 + mapObjects[internal_name].x / 2) +
                    'px' +
                    '; top: ' +
                    (2500 + mapObjects[internal_name].y / 2) +
                    'px'
            );
            waypoint.id = internal_name;
            waypoint.setAttribute(
                'data-display_name',
                mapObjects[internal_name].display_name
            );

            fragment.appendChild(waypoint);
        }

        map.appendChild(fragment);
    },

    drawKorokPaths(notFoundKoroks) {
        var group = document.getElementById('path-group');
        var fragment = document.createDocumentFragment();

        for (var internal_name in notFoundKoroks) {
            if (typeof korokPaths[internal_name] == 'undefined') continue;

            var points = korokPaths[internal_name].points;

            var path = document.createElementNS(
                    'http://www.w3.org/2000/svg',
                    'path'
                ),
                d = '';

            for (var index in points) {
                if (index == 0) {
                    d = d + 'M ';
                } else {
                    d = d + ' L';
                }

                d =
                    d +
                    (3000 + points[index].x / 2) +
                    ' ' +
                    (2500 + points[index].y / 2);
            }

            path.setAttribute('d', d);

            path.setAttribute('class', 'line ' + internal_name);

            fragment.appendChild(path);
        }

        group.appendChild(fragment);
    },

    /* save function */
    save: function () {}
};

function onScroll() {
    var h = document
        .getElementById('header-top')
        .getBoundingClientRect().height;
    if (window.scrollY > h) {
        document.getElementById('header').style.position = 'fixed';
        document.getElementById('header').style.top = '-' + h + 'px';
    } else {
        document.getElementById('header').style.position = 'fixed';
        document.getElementById('header').style.top = '0px';
    }
}

window.addEventListener(
    'load',
    function () {
        // Hide drag-and-drop zone immediately — save file is always auto-loaded from server
        hide('dragzone');

        // Split warps into shrines and towers — must run after map-locations.js is loaded
        for (var _warpHash in warps) {
            if (
                warps[_warpHash].internal_name.indexOf('Location_Dungeon') === 0
            ) {
                shrines[_warpHash] = warps[_warpHash];
            } else if (
                warps[_warpHash].internal_name.indexOf('Location_MapTower') ===
                0
            ) {
                towers[_warpHash] = warps[_warpHash];
            } else if (
                warps[_warpHash].internal_name.indexOf('Location_Remains') === 0
            ) {
                divineBeasts[_warpHash] = warps[_warpHash];
            } else if (
                warps[_warpHash].internal_name.indexOf(
                    'Location_AncientLabo'
                ) === 0 ||
                warps[_warpHash].internal_name.indexOf(
                    'Location_HatenoLabo'
                ) === 0
            ) {
                labos[_warpHash] = warps[_warpHash];
            } else {
                remainingWarps[_warpHash] = warps[_warpHash];
            }
        }

        // Cache totals — these are constants derived from map-locations.js, never change at runtime
        totalShrines = Object.keys(shrines).length;
        totalTowers = Object.keys(towers).length;
        totalDivineBeasts = Object.keys(divineBeasts).length;
        totalShrineCompletions = Object.keys(shrineCompletions).length;

        window.addEventListener('scroll', onScroll, false);

        // Fetch the save file from the server and re-render the map
        var lastMtime = null;
        function loadSaveFromServer() {
            fetch('/data/game_data.sav', { cache: 'no-store' })
                .then(function (response) {
                    if (!response.ok) throw new Error('Save file not found');
                    var mtime =
                        parseFloat(response.headers.get('X-File-Mtime')) ||
                        null;
                    return response.arrayBuffer().then(function (buf) {
                        return { buf: buf, mtime: mtime };
                    });
                })
                .then(function (result) {
                    if (lastMtime && result.mtime && result.mtime !== lastMtime) {
                        _dismissedWaypoints.koroks.clear();
                        _dismissedWaypoints.locations.clear();
                        BotWApi.delete('/api/state/dismissed/all');
                    }
                    removeAllWaypoints();
                    loadSavegameFromArrayBuffer(result.buf, 'game_data.sav');
                    lastMtime = result.mtime;
                    if (result.mtime) updateSaveTimestamp(result.mtime);
                })
                .catch(function () {
                    console.log('Waiting for save file...');
                });
        }

        // Track Player toggle — click the row to enable/disable
        var trackPlayerRow = document.getElementById('track-player-row');
        if (trackPlayerRow) {
            trackPlayerRow.addEventListener('click', function () {
                var isTracking =
                    trackPlayerRow.getAttribute('data-tracking') === 'true';
                var next = !isTracking;
                trackPlayerRow.setAttribute('data-tracking', next ? 'true' : 'false');
                BotWApi.patch('/api/state/track-player', { enabled: next });
            });
        }

        // Track Player zoom slider — persist value via server API
        var trackZoomSlider = document.getElementById('track-zoom-slider');
        var _saveTrackZoom = BotWApi.debounce(function (zoom) {
            BotWApi.patch('/api/state/track-zoom', { zoom: zoom });
        }, 500);
        if (trackZoomSlider) {
            trackZoomSlider.addEventListener('input', function () {
                _saveTrackZoom(parseFloat(trackZoomSlider.value));
            });
        }

        // Fetch state from server. Returns a Promise resolving to the state object or null.
        function syncStateFromServer() {
            return BotWApi.get('/api/state')
                .then(function (data) {
                    return data && data.ok ? data.state : null;
                })
                .catch(function () {
                    return null;
                });
        }

        // Apply server state to the UI.
        // applyToMap=false: only set attributes (used on init before waypoints exist).
        // applyToMap=true: also update waypoint visibility and remove newly dismissed items.
        // restoreMapView=true: restore saved pan/zoom (only on initial page load).
        function applyState(s, applyToMap, restoreMapView) {
            if (!s) return;

            // Audio feedback — play a tone when specific state categories change
            var prev = _prevAppliedState;
            if (prev) {
                // Map stat overrides changed
                if (JSON.stringify(s.statOverrides) !== JSON.stringify(prev.statOverrides))
                    playTone('mapStats');
                // Player stat overrides changed
                if (JSON.stringify(s.playerStatOverrides) !== JSON.stringify(prev.playerStatOverrides))
                    playTone('playerStats');
                // Server status (last update timestamp) changed
                if (JSON.stringify(s.serverStatusOverride) !== JSON.stringify(prev.serverStatusOverride))
                    playTone('lastUpdate');
                // Sidebar type/service visibility changed — detect enable vs disable
                var prevHiddenCount = ((prev.hiddenTypes || []).length + (prev.hiddenServices || []).length);
                var nextHiddenCount = ((s.hiddenTypes || []).length + (s.hiddenServices || []).length);
                if (nextHiddenCount > prevHiddenCount) playTone('sidebarOff');
                else if (nextHiddenCount < prevHiddenCount) playTone('sidebarOn');
            }

            // Dismissed waypoints
            var newKoroks = new Set(
                s.dismissedWaypoints ? s.dismissedWaypoints.koroks || [] : []
            );
            var newLocations = new Set(
                s.dismissedWaypoints ? s.dismissedWaypoints.locations || [] : []
            );
            if (applyToMap) {
                // Remove any waypoints dismissed via external API call
                newKoroks.forEach(function (name) {
                    if (!_dismissedWaypoints.koroks.has(name)) {
                        if (locationValues.notFound && locationValues.notFound.koroks)
                            delete locationValues.notFound.koroks[name];
                        var el = document.getElementById(name);
                        if (el) {
                            el.remove();
                            [].forEach.call(
                                document.querySelectorAll('.line.' + name),
                                function (l) { l.remove(); }
                            );
                            if (locationValues.found) {
                                locationValues.found.koroks =
                                    (locationValues.found.koroks || 0) + 1;
                                setValue('span-number-koroks', locationValues.found.koroks);
                            }
                        }
                    }
                });
                newLocations.forEach(function (name) {
                    if (!_dismissedWaypoints.locations.has(name)) {
                        if (locationValues.notFound && locationValues.notFound.locations)
                            delete locationValues.notFound.locations[name];
                        var el = document.getElementById(name);
                        if (el) {
                            el.remove();
                            if (locationValues.found) {
                                locationValues.found.locations =
                                    (locationValues.found.locations || 0) + 1;
                                setValue('span-number-locations-visited', locationValues.found.locations);
                                setValue('span-number-locations', 226 - locationValues.found.locations);
                            }
                        }
                    }
                });
            }
            _dismissedWaypoints.koroks = newKoroks;
            _dismissedWaypoints.locations = newLocations;

            // Track player
            var row = document.getElementById('track-player-row');
            if (row)
                row.setAttribute('data-tracking', s.trackPlayer ? 'true' : 'false');

            // Track zoom
            if (trackZoomSlider && s.trackZoom != null) {
                trackZoomSlider.value = s.trackZoom;
                // Re-center immediately when zoom changes while tracking is active
                if (row && row.getAttribute('data-tracking') === 'true' && window._playerMapPos && window.MapView) {
                    window.MapView.smoothCenterOn(
                        window._playerMapPos.x,
                        window._playerMapPos.y,
                        window.MapView.getTrackZoom()
                    );
                }
            }

            // Player position override — place marker and re-center if tracking
            if (s.playerPositionOverride) {
                placePlayerMarker(s.playerPositionOverride.x, s.playerPositionOverride.z, 'Player');
                if (row && row.getAttribute('data-tracking') === 'true' && window._playerMapPos && window.MapView) {
                    window.MapView.smoothCenterOn(
                        window._playerMapPos.x,
                        window._playerMapPos.y,
                        window.MapView.getTrackZoom()
                    );
                }
            }

            // Map view — only restore on initial page load, not during poll syncs
            if (
                restoreMapView &&
                s.mapView &&
                s.mapView.scale !== null &&
                window.MapView
            ) {
                window.MapView.setView(
                    s.mapView.scale,
                    s.mapView.panX || 0,
                    s.mapView.panY || 0
                );
            }

            // Hidden types
            [].forEach.call(
                document.querySelectorAll('#toolbar label[data-type]'),
                function (label) {
                    var type = label.getAttribute('data-type');
                    if (s.hiddenTypes && s.hiddenTypes.indexOf(type) !== -1) {
                        label.setAttribute('data-hidden', 'true');
                    } else {
                        label.removeAttribute('data-hidden');
                    }
                }
            );

            // Hidden services
            [].forEach.call(
                document.querySelectorAll('#services-section label[data-service]'),
                function (label) {
                    var svc = label.getAttribute('data-service');
                    if (s.hiddenServices && s.hiddenServices.indexOf(svc) !== -1) {
                        label.setAttribute('data-hidden', 'true');
                    } else {
                        label.removeAttribute('data-hidden');
                    }
                }
            );

            if (applyToMap) {
                applyHiddenStates();
                applyServiceHiddenStates();
            }

            // Player stat overrides (for test sweeps)
            if (s.playerStatOverrides) {
                var ps = s.playerStatOverrides;
                if (ps.hearts != null) setValue('span-stat-hearts', ps.hearts);
                if (ps.stamina != null) setValue('span-stat-stamina', parseFloat(ps.stamina).toFixed(1));
                if (ps.playtime != null) setValue('span-stat-playtime', formatPlaytime(ps.playtime));
                if (ps.rupees != null) setValue('span-stat-rupees', Math.round(ps.rupees).toLocaleString());
                if (ps.motorcycle != null) setMotorcycleIndicator(ps.motorcycle);
            }

            // Server status override (for test sweeps)
            if (s.serverStatusOverride) {
                if (s.serverStatusOverride.timestamp != null) updateSaveTimestamp(s.serverStatusOverride.timestamp);
                if (s.serverStatusOverride.online != null) setServerOnline(s.serverStatusOverride.online);
            }

            // Stat overrides (for test sweeps — bypasses save-file derived values)
            if (s.statOverrides) {
                var ov = s.statOverrides;
                if (ov.koroks != null) setValue('span-number-koroks', ov.koroks);
                if (ov.locations != null) setValue('span-number-locations', ov.locations);
                if (ov.locationsVisited != null) setValue('span-number-locations-visited', ov.locationsVisited);
                if (ov.shrines != null) setValue('span-number-shrines', ov.shrines);
                if (ov.shrinesCompleted != null) setValue('span-number-shrines-completed', ov.shrinesCompleted);
                if (ov.shrinesNotActivated != null) setValue('span-number-shrines-not-activated', ov.shrinesNotActivated);
                if (ov.towers != null) setValue('span-number-towers', ov.towers);
                if (ov.divineBeasts != null) setValue('span-number-divine-beasts-incomplete', ov.divineBeasts);
                if (ov.divineBeatsCompleted != null) setValue('span-number-divine-beasts-completed', ov.divineBeatsCompleted);
            }

            // Test mode banner — testMode is a string (phase label) or falsy
            var banner = document.getElementById('test-banner');
            if (banner) banner.textContent = s.testMode ? ('⚠ ' + s.testMode) : '';
            document.body.classList.toggle('test-mode', !!s.testMode);

            _prevAppliedState = s;
            _lastStateVersion = s.stateVersion || 0;
        }

        // Set up toolbar hover highlighting — labels are always in DOM
        // Register debounced map-view save via MapView.onZoom
        var _saveMapView = BotWApi.debounce(function () {
            if (!window.MapView) return;
            var v = window.MapView.getView();
            BotWApi.patch('/api/state/map-view', v);
        }, 1000);
        if (window.MapView) window.MapView.onZoom(_saveMapView);

        syncStateFromServer().then(function (s) {
            applyState(s, false, true);
            setupToolbarHover();
            setupServiceToggles();
            loadSaveFromServer();
        });

        // Poll /api/mtime every 10 seconds; re-render only when the file has changed
        function pollMtime() {
            fetch('/api/mtime', { cache: 'no-store' })
                .then(function (r) {
                    return r.json();
                })
                .then(function (data) {
                    setServerOnline(true);
                    if (data.mtime) updateSaveTimestamp(data.mtime);
                    if (data.mtime && data.mtime !== lastMtime) {
                        loadSaveFromServer();
                    } else if (
                        typeof data.stateVersion === 'number' &&
                        data.stateVersion !== _lastStateVersion
                    ) {
                        syncStateFromServer().then(function (s) {
                            applyState(s, true, false);
                        });
                    }
                    // Track Player: re-center on every poll if enabled (covers manual panning between saves)
                    var toggle = document.getElementById('track-player-row');
                    if (
                        toggle &&
                        toggle.getAttribute('data-tracking') === 'true' &&
                        window._playerMapPos &&
                        window.MapView
                    ) {
                        window.MapView.smoothCenterOn(
                            window._playerMapPos.x,
                            window._playerMapPos.y,
                            window.MapView.getTrackZoom()
                        );
                    }
                })
                .catch(function () {
                    setServerOnline(false);
                });
        }
        pollMtime();
        setInterval(pollMtime, 10000);

        // SSE — react to server state changes immediately without waiting for the poll.
        // Full state is included in the event payload so no extra fetch is needed.
        var _sseSource = new EventSource('/api/events');
        _sseSource.addEventListener('state-change', function (e) {
            var data = JSON.parse(e.data);
            if (typeof data.stateVersion === 'number' && data.stateVersion !== _lastStateVersion) {
                if (data.state) {
                    applyState(data.state, true, false);
                } else {
                    syncStateFromServer().then(function (s) {
                        applyState(s, true, false);
                    });
                }
            }
        });
        _sseSource.addEventListener('reload-save', function () {
            loadSaveFromServer();
        });

        function setServerOnline(online) {
            var dot = document.getElementById('server-status-dot');
            if (dot)
                dot.className =
                    'server-status-dot ' + (online ? 'online' : 'offline');
        }

        function updateSaveTimestamp(mtime) {
            var el = document.getElementById('save-timestamp');
            if (!el) return;
            var d = new Date(mtime);
            var pad = function (n) {
                return n < 10 ? '0' + n : n;
            };
            el.innerHTML =
                pad(d.getMonth() + 1) +
                '/' +
                pad(d.getDate()) +
                '/' +
                d.getFullYear() +
                '<br>' +
                pad(d.getHours()) +
                ':' +
                pad(d.getMinutes()) +
                ':' +
                pad(d.getSeconds());
        }

        // Empty data for a clear map
        document.getElementById('clear').addEventListener('click', function () {
            locationValues.notFound = {
                koroks: {},
                locations: {},
                shrines: {},
                towers: {},
                divineBeasts: {}
            };

            locationValues.found = {
                koroks: 0,
                locations: 0,
                shrines: 0,
                towers: 0,
                divineBeasts: 0
            };

            for (var hash in koroks) {
                locationValues.notFound.koroks[koroks[hash]['internal_name']] =
                    {
                        display_name: koroks[hash]['display_name'],
                        x: koroks[hash]['x'],
                        y: koroks[hash]['y'],
                        offset: null // Not loaded from a save
                    };
            }

            for (var hash in locations) {
                locationValues.notFound.locations[
                    locations[hash]['internal_name']
                ] = {
                    display_name: locations[hash]['display_name'],
                    x: locations[hash]['x'],
                    y: locations[hash]['y'],
                    offset: null // Not loaded from a save
                };
            }

            renderStats(locationValues.found.koroks, 0, 0);

            SavegameEditor.drawKorokPaths(locationValues.notFound.koroks);

            SavegameEditor.markMap(
                locationValues.notFound.locations,
                'location'
            );
            SavegameEditor.markMap(shrines, 'shrine');
            SavegameEditor.markMap(locationValues.notFound.shrines, 'shrine-not-activated');
            SavegameEditor.markMap(towers, 'tower');
            SavegameEditor.markMap(divineBeasts, 'divine-beast');
            SavegameEditor.markMap(labos, 'labo');
            SavegameEditor.markMap(remainingWarps, 'warp');
            SavegameEditor.markMap(locationValues.notFound.koroks, 'korok');

            hide('dragzone');
            show('the-editor');
            show('toolbar', 'flex');

            addWaypointListeners();
            applyHiddenStates();
            applyServiceHiddenStates();
        });

        initRegionLabels();
        initWaypointListeners();
    },
    false
);

// Render region name labels on the map at zoom-appropriate detail levels.
// level 0 = main regions (zoomed out), level 1 = broad areas, level 2 = sub-regions.
function initRegionLabels() {
    if (!window.regionLabels || !window.MapView) return;
    var container = document.getElementById('map-container');
    if (!container) return;

    // Screen-pixel font size for each level (divided by scale to stay constant on screen)
    var screenSizes = { 0: 22, 1: 18, 2: 16, 3: 16, 4: 14 };

    var items = [];
    window.regionLabels.forEach(function (r) {
        var el = document.createElement('div');
        el.className = 'region-label region-level-' + r.level;
        el.textContent = r.name;
        el.style.left = 3000 + r.x / 2 + 'px';
        el.style.top = 2500 + r.z / 2 + 'px';
        el.style.display = 'none';
        container.appendChild(el);
        items.push({ el: el, level: r.level });
    });

    function update(scale, minZoom, maxZoom) {
        var pct =
            maxZoom > minZoom ? (scale - minZoom) / (maxZoom - minZoom) : 0;
        items.forEach(function (item) {
            var visible;
            if (item.level === 0) visible = pct <= 0.35;
            else if (item.level === 1) visible = pct >= 0.1 && pct <= 0.65;
            else if (item.level === 2) visible = pct >= 0.3 && pct <= 0.8;
            else if (item.level === 3) visible = pct >= 0.5;
            else visible = pct >= 0.7;
            item.el.style.display = visible ? '' : 'none';
            if (visible)
                item.el.style.fontSize = screenSizes[item.level] / scale + 'px';
        });
    }

    window.MapView.onZoom(update);
    var zi = window.MapView.getZoomInfo();
    update(zi.scale, zi.minZoom, zi.maxZoom);
}

// Toolbar label hover — highlight matching map icons
function setupToolbarHover() {
    [].forEach.call(
        document.querySelectorAll('#toolbar label[data-type]'),
        function (label) {
            var type = label.getAttribute('data-type');

            label.addEventListener('mouseenter', function () {
                [].forEach.call(
                    document.querySelectorAll('.waypoint.' + type),
                    function (wp) {
                        wp.classList.add('highlighted');
                    }
                );
            });
            label.addEventListener('mouseleave', function () {
                [].forEach.call(
                    document.querySelectorAll('.waypoint.highlighted'),
                    function (wp) {
                        wp.classList.remove('highlighted');
                    }
                );
            });
            label.addEventListener('click', function () {
                var isHidden = label.getAttribute('data-hidden') === 'true';
                if (isHidden) {
                    label.removeAttribute('data-hidden');
                    BotWApi.patch('/api/state/hidden-types', {
                        type: type,
                        hidden: false
                    });
                    [].forEach.call(
                        document.querySelectorAll('.waypoint.' + type),
                        function (wp) {
                            wp.style.display = '';
                        }
                    );
                    if (type === 'korok') {
                        [].forEach.call(
                            document.querySelectorAll('#path-group .line'),
                            function (ln) {
                                ln.style.display = '';
                            }
                        );
                    }
                } else {
                    label.setAttribute('data-hidden', 'true');
                    BotWApi.patch('/api/state/hidden-types', {
                        type: type,
                        hidden: true
                    });
                    [].forEach.call(
                        document.querySelectorAll('.waypoint.' + type),
                        function (wp) {
                            wp.style.display = 'none';
                        }
                    );
                    if (type === 'korok') {
                        [].forEach.call(
                            document.querySelectorAll('#path-group .line'),
                            function (ln) {
                                ln.style.display = 'none';
                            }
                        );
                    }
                }
            });
        }
    );
}

// Re-apply hidden states after waypoints are recreated on reload
function applyHiddenStates() {
    [].forEach.call(
        document.querySelectorAll('#toolbar label[data-hidden="true"]'),
        function (label) {
            var type = label.getAttribute('data-type');
            [].forEach.call(
                document.querySelectorAll('.waypoint.' + type),
                function (wp) {
                    wp.style.display = 'none';
                }
            );
            if (type === 'korok') {
                [].forEach.call(
                    document.querySelectorAll('#path-group .line'),
                    function (ln) {
                        ln.style.display = 'none';
                    }
                );
            }
        }
    );
}

// Service type toggles — sub-filters within location-discovered by data-location-type
function setupServiceToggles() {
    [].forEach.call(
        document.querySelectorAll('#services-section label[data-service]'),
        function (label) {
            var svcType = label.getAttribute('data-service');

            label.addEventListener('mouseenter', function () {
                [].forEach.call(
                    document.querySelectorAll(
                        '.waypoint.location-discovered[data-location-type="' +
                            svcType +
                            '"]'
                    ),
                    function (wp) {
                        wp.classList.add('highlighted');
                    }
                );
            });
            label.addEventListener('mouseleave', function () {
                [].forEach.call(
                    document.querySelectorAll('.waypoint.highlighted'),
                    function (wp) {
                        wp.classList.remove('highlighted');
                    }
                );
            });
            label.addEventListener('click', function () {
                var isHidden = label.getAttribute('data-hidden') === 'true';
                if (isHidden) {
                    label.removeAttribute('data-hidden');
                    BotWApi.patch('/api/state/hidden-services', {
                        service: svcType,
                        hidden: false
                    });
                    [].forEach.call(
                        document.querySelectorAll(
                            '.waypoint.location-discovered[data-location-type="' +
                                svcType +
                                '"]'
                        ),
                        function (wp) {
                            wp.style.display = '';
                        }
                    );
                } else {
                    label.setAttribute('data-hidden', 'true');
                    BotWApi.patch('/api/state/hidden-services', {
                        service: svcType,
                        hidden: true
                    });
                    [].forEach.call(
                        document.querySelectorAll(
                            '.waypoint.location-discovered[data-location-type="' +
                                svcType +
                                '"]'
                        ),
                        function (wp) {
                            wp.style.display = 'none';
                        }
                    );
                }
            });
        }
    );
}

// Re-apply service hidden states after waypoints are recreated on reload
function applyServiceHiddenStates() {
    [].forEach.call(
        document.querySelectorAll(
            '#services-section label[data-hidden="true"]'
        ),
        function (label) {
            var svcType = label.getAttribute('data-service');
            [].forEach.call(
                document.querySelectorAll(
                    '.waypoint.location-discovered[data-location-type="' +
                        svcType +
                        '"]'
                ),
                function (wp) {
                    wp.style.display = 'none';
                }
            );
        }
    );
}

// Set up delegated event listeners on #map-container — called once on page load.
// Handles click (dismiss), mouseover (tooltip), and mouseout (hide tooltip) for all waypoints
// without registering individual listeners per element.
function initWaypointListeners() {
    var container = document.getElementById('map-container');
    container.addEventListener('click', function (e) {
        var wp = e.target.closest('.waypoint');
        if (wp && !wp.classList.contains('warp')) removeWaypoint(wp);
    });
    container.addEventListener('mouseover', function (e) {
        var wp = e.target.closest('.waypoint');
        if (wp) showWaypointTooltip(wp);
    });
    container.addEventListener('mouseout', function (e) {
        var wp = e.target.closest('.waypoint');
        if (wp && !wp.contains(e.relatedTarget)) hideWaypointTooltip();
    });
}

var _waypointTooltip = null;

// Show a floating label next to a map icon.
// Tooltip is a single reused DOM element positioned in map coordinates.
// Offset accounts for circle vs diamond geometry so the label clears the pin at all zoom levels.
function showWaypointTooltip(waypoint) {
    var name = waypoint.getAttribute('data-display_name');
    if (!name) return;

    if (!_waypointTooltip) {
        _waypointTooltip = document.createElement('div');
        _waypointTooltip.id = 'waypoint-tooltip';
        document.getElementById('map-container').appendChild(_waypointTooltip);
    }

    // Waypoint left/top are the map-coordinate anchor point.
    // Circles: transform: translate(-5px,-5px) — visual center is at (left, top)
    // Diamonds: transform: translate(-2px,0) rotate(45deg) around top-right —
    //   rightmost visual tip is at approx (left+8.6, top-1.4) in map coords.
    var L = parseFloat(waypoint.style.left) || 0;
    var T = parseFloat(waypoint.style.top) || 0;
    var isDiamond =
        waypoint.classList.contains('divine-beast') ||
        waypoint.classList.contains('divine-beast-completed') ||
        waypoint.classList.contains('warp');
    var isIcon =
        waypoint.classList.contains('shrine') ||
        waypoint.classList.contains('shrine-not-activated') ||
        waypoint.classList.contains('shrine-completed') ||
        waypoint.classList.contains('tower') ||
        waypoint.classList.contains('korok') ||
        waypoint.classList.contains('labo') ||
        waypoint.classList.contains('location-discovered');

    var scale =
        parseFloat(
            getComputedStyle(document.documentElement).getPropertyValue(
                '--map-scale'
            )
        ) || 1;
    var GAP = 10 / scale; // constant 10px gap in screen space, expressed in map coords

    var tx, ty;
    if (isDiamond) {
        tx = L + 8.6 + GAP; // start from right tip of diamond
        ty = T - 1.4; // visual center y of diamond
    } else if (isIcon) {
        tx = L + 5 + GAP; // start from right edge of 10px icon
        ty = T;
    } else {
        tx = L + 5 + GAP; // start from right edge of circle (radius 5)
        ty = T; // visual center y of circle
    }

    _waypointTooltip.textContent = name;
    _waypointTooltip.style.left = tx + 'px';
    _waypointTooltip.style.top = ty + 'px';
    _waypointTooltip.style.display = 'block';
}

function hideWaypointTooltip() {
    if (_waypointTooltip) _waypointTooltip.style.display = 'none';
}

// Remove an individual Waypoint and save that change in localStorage
function removeWaypoint(element) {
    var type;

    if (element.classList.contains('korok')) {
        type = 'koroks';
    } else {
        type = 'locations';
    }

    delete locationValues.notFound[type][element.id];

    locationValues.found[type]++;

    setValue('span-number-' + type, locationValues.found[type]);

    var apiType = type === 'koroks' ? 'korok' : 'location';
    BotWApi.post('/api/state/dismissed', { type: apiType, name: element.id });

    element.remove();

    if (type == 'koroks') {
        // Remove lines when necessary
        [].forEach.call(
            document.querySelectorAll('.line.' + element.id),
            function (line) {
                line.remove();
            }
        );
    }
}

// Render stat display values into the toolbar spans
function renderStats(korokCount, shrinesCompletedCount, divineBeastsCompletedCount) {
    setValue('span-number-koroks', korokCount);
    setValue('span-number-locations', 226 - locationValues.found.locations);
    setValue('span-number-total-locations', 226);
    setValue('span-number-locations-visited', locationValues.found.locations);
    setValue('span-number-total-locations-visited', 226);
    setValue('span-number-shrines', locationValues.found.shrines - shrinesCompletedCount);
    setValue('span-number-total-shrines', totalShrines);
    setValue('span-number-shrines-not-activated',
        locationValues.notFound.shrines ? Object.keys(locationValues.notFound.shrines).length : 0);
    setValue('span-number-total-shrines-not-activated', totalShrines);
    setValue('span-number-shrines-completed', shrinesCompletedCount);
    setValue('span-number-total-shrines-completed', totalShrineCompletions);
    setValue('span-number-towers', locationValues.found.towers);
    setValue('span-number-total-towers', totalTowers);
    setValue('span-number-divine-beasts-incomplete', locationValues.found.divineBeasts - divineBeastsCompletedCount);
    setValue('span-number-total-divine-beasts-incomplete', totalDivineBeasts);
    setValue('span-number-divine-beasts-completed', divineBeastsCompletedCount);
    setValue('span-number-total-divine-beasts-completed', totalDivineBeasts);
}

// Remove all Waypoints
function removeAllWaypoints() {
    hideWaypointTooltip();
    var map = document.getElementById('map-container');
    var waypoints = map.querySelectorAll('.waypoint');
    for (var i = 0; i < waypoints.length; i++) {
        waypoints[i].remove();
    }
    document.getElementById('path-group').innerHTML = '';
}

// Place (or replace) the player position marker on the map.
// x/z are BotW world coordinates; label defaults to 'Player'.
// Also stores map coordinates in window._playerMapPos for Track Player.
function placePlayerMarker(x, z, label) {
    var map = document.getElementById('map-container');
    var existing = document.getElementById('player-position-marker');
    if (existing) existing.remove();
    var marker = document.createElement('div');
    marker.id = 'player-position-marker';
    marker.classList.add('waypoint', 'player-position');
    marker.style.left = 3000 + x / 2 + 'px';
    marker.style.top = 2500 + z / 2 + 'px';
    marker.setAttribute('data-display_name', label || 'Player');
    map.appendChild(marker);
    // Store for Track Player feature
    window._playerMapPos = { x: 3000 + x / 2, y: 2500 + z / 2 };
}

// Search for a hash at stride 4 (used for string-type save entries not at 8-byte stride)
function searchHashStride4(hash) {
    for (var i = 0x0c; i < tempFile.fileSize - 4; i += 4)
        if (hash === tempFile.readU32(i)) return i;
    return -1;
}

// If the player is inside a shrine interior, return the shrine's overworld {x, y} coords.
// MAP hash (0x0bee9e46) stores the current sublevel name fragmented across consecutive
// [hash, 4-byte-chunk] pairs — e.g. "Dung"+"eon0"+"22\0" = "Dungeon022" when inside a shrine.
// In the overworld it stores "MainField" (or similar), which won't match.
// Returns null if overworld or hash not found.
function getShrineOverworldCoords() {
    var HASH = 0x0bee9e46;
    var off = searchHashStride4(HASH);
    if (off < 0) return null;
    // Collect 4-byte chunks from consecutive [hash, value] pairs
    var mapName = '';
    var done = false;
    while (
        !done &&
        off + 8 <= tempFile.fileSize &&
        tempFile.readU32(off) === HASH
    ) {
        for (var b = 0; b < 4; b++) {
            var c = tempFile.readU8(off + 4 + b);
            if (c === 0) {
                done = true;
                break;
            }
            mapName += String.fromCharCode(c);
        }
        off += 8;
    }
    var m = /^Dungeon(\d+)/.exec(mapName);
    if (!m) return null;
    var target = 'Location_Dungeon' + m[1];
    for (var warpHash in warps) {
        if (warps[warpHash].internal_name === target)
            return { x: warps[warpHash].x, y: warps[warpHash].y };
    }
    return null;
}

// Format a raw playtime value (seconds) as H:MM:SS.
function formatPlaytime(seconds) {
    var h = Math.floor(seconds / 3600);
    var m = Math.floor((seconds % 3600) / 60);
    var s = seconds % 60;
    return h + ':' + (m < 10 ? '0' + m : m) + ':' + (s < 10 ? '0' + s : s);
}

// Toggle the motorcycle indicator light green (owned) or red (not yet obtained).
function setMotorcycleIndicator(owned) {
    var el = document.getElementById('stat-motorcycle-light');
    if (el)
        el.className = 'motorcycle-light ' + (owned ? 'owned' : 'not-owned');
}

// Shared AudioContext — created and resumed on first user gesture to satisfy
// browser autoplay policy. Reused for all subsequent tones.
var _audioCtx = null;
function _getAudioCtx() {
    if (!_audioCtx) {
        try { _audioCtx = new (window.AudioContext || window.webkitAudioContext)(); } catch (e) { return null; }
    }
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
    return _audioCtx;
}
// Warm up the AudioContext on first user interaction so SSE-triggered tones work.
document.addEventListener('click', _getAudioCtx, { once: false, passive: true });
document.addEventListener('keydown', _getAudioCtx, { once: false, passive: true });

// Play a short soothing tone for a given change type.
// Each type has a distinct pitch and envelope. Throttled per-key to avoid stacking.
var _toneThrottle = {};
var _toneConfigs = {
    mapStats:    { freq: 523.25, type: 'sine',     attack: 0.01, sustain: 0.12, decay: 0.35 }, // C5
    playerStats: { freq: 392.00, type: 'sine',     attack: 0.01, sustain: 0.10, decay: 0.40 }, // G4
    sidebarOn:   { freq: 659.25, type: 'triangle', attack: 0.01, sustain: 0.08, decay: 0.30 }, // E5
    sidebarOff:  { freq: 293.66, type: 'triangle', attack: 0.01, sustain: 0.08, decay: 0.30 }, // D4
    lastUpdate:  { freq: 440.00, type: 'sine',     attack: 0.02, sustain: 0.15, decay: 0.45 }, // A4
};
function playTone(key) {
    if (_toneThrottle[key]) return;
    _toneThrottle[key] = true;
    setTimeout(function () { _toneThrottle[key] = false; }, 150);
    var cfg = _toneConfigs[key];
    if (!cfg) return;
    var ctx = _getAudioCtx();
    if (!ctx || ctx.state === 'closed') return;
    function scheduleNote() {
        if (!ctx || ctx.state !== 'running') return;
        // During test mode use staccato envelope (1/4 duration); normal play is full length.
        var testing = document.body.classList.contains('test-mode');
        var attack  = testing ? cfg.attack * 0.5 : cfg.attack;
        var sustain = testing ? cfg.sustain * 0.25 : cfg.sustain;
        var decay   = testing ? cfg.decay * 0.25 : cfg.decay;
        try {
            var osc = ctx.createOscillator();
            var gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.type = cfg.type;
            osc.frequency.value = cfg.freq;
            gain.gain.setValueAtTime(0, ctx.currentTime);
            gain.gain.linearRampToValueAtTime(0.18, ctx.currentTime + attack);
            gain.gain.setValueAtTime(0.18, ctx.currentTime + attack + sustain);
            gain.gain.exponentialRampToValueAtTime(0.0001, ctx.currentTime + attack + sustain + decay);
            osc.start(ctx.currentTime);
            osc.stop(ctx.currentTime + attack + sustain + decay);
        } catch (e) { /* oscillator scheduling failed */ }
    }
    if (ctx.state === 'running') {
        scheduleNote();
    } else {
        ctx.resume().then(scheduleNote).catch(function () {});
    }
}

// Map pan and zoom functionality
(function () {
    var scale = 1;
    var panX = 0;
    var panY = 0;
    var isPanning = false;
    var _smoothAnimFrame = null;
    var _transitionTimeout = null;
    var startX = 0;
    var startY = 0;
    var mapContainer = null;
    var mapViewport = null;
    var minZoom = 1;
    var maxZoom = 1;
    var zoomLabelTimer = null;
    var _zoomListeners = [];

    // Show the zoom percentage label briefly, then fade it out after 3s.
    // 0% = fully zoomed out (minZoom), 100% = fully zoomed in (maxZoom).
    function showZoomLabel() {
        var label = document.getElementById('zoom-label');
        if (!label) return;
        var pct =
            maxZoom > minZoom
                ? Math.round(((scale - minZoom) / (maxZoom - minZoom)) * 100)
                : 0;
        label.textContent = pct + '%';
        label.classList.add('visible');
        clearTimeout(zoomLabelTimer);
        zoomLabelTimer = setTimeout(function () {
            label.classList.remove('visible');
        }, 3000);
    }

    function initMapPanZoom() {
        mapViewport = document.getElementById('map-viewport');
        mapContainer = document.getElementById('map-container');

        if (!mapViewport || !mapContainer) return;

        // Calculate zoom limits based on map dimensions (6000x5000px) vs viewport
        var mapWidth = 6000;
        var mapHeight = 5000;
        var viewportWidth = mapViewport.clientWidth || window.innerWidth;
        var viewportHeight = mapViewport.clientHeight || window.innerHeight;
        minZoom = Math.min(
            viewportWidth / mapWidth,
            viewportHeight / mapHeight
        );
        maxZoom = mapHeight / viewportHeight;

        // Wrap map-container in viewport if not already
        if (mapContainer.parentElement !== mapViewport) {
            mapViewport.appendChild(mapContainer);
        }

        // Start fully zoomed out
        scale = minZoom;
        panX = 0;
        panY = 0;
        document.documentElement.style.setProperty('--map-scale', scale);
        updateTransform();

        // Mouse wheel for zoom
        mapViewport.addEventListener(
            'wheel',
            function (e) {
                e.preventDefault();

                var zoomFactor = 0.1;
                var delta = e.deltaY > 0 ? -zoomFactor : zoomFactor;
                var newScale = Math.max(
                    minZoom,
                    Math.min(maxZoom, scale + delta)
                );

                // Zoom toward mouse position
                var rect = mapViewport.getBoundingClientRect();
                var mouseX = e.clientX - rect.left;
                var mouseY = e.clientY - rect.top;

                // Calculate the point in map coordinates before zoom
                var mapX = (mouseX - panX) / scale;
                var mapY = (mouseY - panY) / scale;

                // Calculate new pan to keep mouse position stable
                panX = mouseX - mapX * newScale;
                panY = mouseY - mapY * newScale;

                scale = newScale;
                updateTransform();
                showZoomLabel();
            },
            { passive: false }
        );

        // Middle mouse button for pan
        mapViewport.addEventListener('mousedown', function (e) {
            if (e.button === 1) {
                // Middle mouse button
                e.preventDefault();
                isPanning = true;
                startX = e.clientX - panX;
                startY = e.clientY - panY;
                mapViewport.style.cursor = 'grabbing';
            }
        });

        document.addEventListener('mousemove', function (e) {
            if (isPanning) {
                panX = e.clientX - startX;
                panY = e.clientY - startY;
                updateTransform();
            }
        });

        document.addEventListener('mouseup', function (e) {
            if (e.button === 1 && isPanning) {
                isPanning = false;
                mapViewport.style.cursor = 'default';
            }
        });

        // Prevent context menu on middle click
        mapViewport.addEventListener('contextmenu', function (e) {
            if (e.button === 1) {
                e.preventDefault();
            }
        });
    }

    function updateTransform() {
        // Cancel any in-progress smooth animation
        mapContainer.style.transition = '';
        if (_transitionTimeout) {
            clearTimeout(_transitionTimeout);
            _transitionTimeout = null;
        }
        // Calculate bounds to prevent showing blank space around map edges
        var mapWidth = 6000;
        var mapHeight = 5000;
        var viewportWidth = mapViewport.clientWidth || window.innerWidth;
        var viewportHeight = mapViewport.clientHeight || window.innerHeight;
        var scaledMapWidth = mapWidth * scale;
        var scaledMapHeight = mapHeight * scale;

        // Calculate min/max pan values
        var maxPanX = 0;
        var maxPanY = 0;
        var minPanX = viewportWidth - scaledMapWidth;
        var minPanY = viewportHeight - scaledMapHeight;

        // If map fits entirely in viewport, center it
        if (scaledMapWidth < viewportWidth) {
            minPanX = maxPanX = (viewportWidth - scaledMapWidth) / 2;
        }
        if (scaledMapHeight < viewportHeight) {
            minPanY = maxPanY = (viewportHeight - scaledMapHeight) / 2;
        }

        // Clamp pan values
        panX = Math.min(maxPanX, Math.max(minPanX, panX));
        panY = Math.min(maxPanY, Math.max(minPanY, panY));

        mapContainer.style.transform =
            'translate(' + panX + 'px, ' + panY + 'px) scale(' + scale + ')';
        document.documentElement.style.setProperty('--map-scale', scale);
        _zoomListeners.forEach(function (cb) {
            cb(scale, minZoom, maxZoom);
        });
    }

    // Expose map controls for external use (e.g. Track Player)
    window.MapView = {
        // Center the map on a given map-coordinate point, optionally setting zoom
        centerOn: function (mapX, mapY, targetScale) {
            if (!mapViewport) return;
            if (targetScale !== undefined)
                scale = Math.max(minZoom, Math.min(maxZoom, targetScale));
            var vw = mapViewport.clientWidth || window.innerWidth;
            var vh = mapViewport.clientHeight || window.innerHeight;
            panX = vw / 2 - mapX * scale;
            panY = vh / 2 - mapY * scale;
            updateTransform();
        },
        // Smoothly pan and zoom to center on a map-coordinate point over ~700ms.
        // Uses a CSS transition so the browser compositor handles interpolation
        // entirely on its own thread — no per-frame JS overhead.
        smoothCenterOn: function (mapX, mapY, targetScale) {
            if (!mapViewport) return;
            if (_smoothAnimFrame) {
                cancelAnimationFrame(_smoothAnimFrame);
                _smoothAnimFrame = null;
            }
            if (_transitionTimeout) {
                clearTimeout(_transitionTimeout);
                _transitionTimeout = null;
            }
            mapContainer.style.transition = '';

            var ts =
                targetScale !== undefined
                    ? Math.max(minZoom, Math.min(maxZoom, targetScale))
                    : scale;
            var vw = mapViewport.clientWidth || window.innerWidth;
            var vh = mapViewport.clientHeight || window.innerHeight;
            scale = ts;
            panX = vw / 2 - mapX * ts;
            panY = vh / 2 - mapY * ts;

            // One rAF so the browser registers the current transform as the start
            // point and finishes any pending DOM work before the transition begins.
            mapContainer.style.willChange = 'transform';
            _smoothAnimFrame = requestAnimationFrame(function () {
                _smoothAnimFrame = null;
                mapContainer.style.transition =
                    'transform 1200ms cubic-bezier(0.215, 0.61, 0.355, 1)';
                mapContainer.style.transform =
                    'translate(' +
                    panX +
                    'px, ' +
                    panY +
                    'px) scale(' +
                    scale +
                    ')';
                _transitionTimeout = setTimeout(function () {
                    _transitionTimeout = null;
                    mapContainer.style.willChange = 'auto';
                    document.documentElement.style.setProperty(
                        '--map-scale',
                        scale
                    );
                }, 1250);
            });
        },
        // Register a callback fired on every zoom/pan transform update: cb(scale, minZoom, maxZoom)
        onZoom: function (cb) {
            _zoomListeners.push(cb);
        },
        // Returns current zoom state for external consumers
        getZoomInfo: function () {
            return { scale: scale, minZoom: minZoom, maxZoom: maxZoom };
        },
        // Directly set scale and pan offsets (used to restore persisted map view)
        setView: function (newScale, newPanX, newPanY) {
            if (!mapViewport) return;
            scale = Math.max(minZoom, Math.min(maxZoom, newScale));
            panX = newPanX || 0;
            panY = newPanY || 0;
            updateTransform();
        },
        // Returns current viewport state for persistence
        getView: function () {
            return { scale: scale, panX: panX, panY: panY };
        },
        // Returns the zoom level used by Track Player: 15% into the full zoom range,
        // ensuring the map is always larger than the viewport so centering works.
        getTrackZoom: function () {
            var slider = document.getElementById('track-zoom-slider');
            var pct = slider ? parseFloat(slider.value) / 100 : 0.15;
            return minZoom + pct * (maxZoom - minZoom);
        }
    };

    // Initialize when DOM is ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', initMapPanZoom);
    } else {
        initMapPanZoom();
    }
})();
