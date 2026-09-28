(function SidebarLyrics() {

    // 0. CSS STYLES FOR CLEAN SIDEBAR & LYRICS
    document.getElementById('custom-sidebar-fixes-style')?.remove();
    const styleEl = document.createElement('style');
    styleEl.id = 'custom-sidebar-fixes-style';
    styleEl.textContent = `
        /* Flex layout for panel container to allow dynamic lyrics filling */
        .main-nowPlayingView-content, .main-nowPlayingView-panel {
            display: flex !important;
            flex-direction: column !important;
            height: 100% !important;
        }
        /* Gently pull up track info section & optimize spacing */
        .main-nowPlayingView-panel > div:first-child,
        .main-nowPlayingView-panel > header:first-child,
        .main-nowPlayingView-panel > .main-nowPlayingView-section:first-child {
            margin-bottom: 0px !important;
            padding-bottom: 0px !important;
        }
        /* Centering inside sidebar */
        [data-testid="now-playing-panel"] .main-nowPlayingView-panel > div {
            justify-content: center !important;
            width: 100% !important;
        }
        [data-testid="now-playing-panel"] {
            height: 100% !important;
        }
        /* Immediately hide all extra cards except queue and our custom lyrics container */
        .main-nowPlayingView-section:not(.main-nowPlayingView-queue):not(#custom-sidebar-lyrics) {
            display: none !important;
        }
        #custom-sidebar-lyrics {
            flex: 1 1 auto !important;
            height: 0 !important;
            min-height: 120px !important;
            margin-top: -4px !important;
            padding-top: 0px !important;
        }
    `;
    document.head.appendChild(styleEl);

    // 2. LYRICS IN RIGHT SIDEBAR (SMOOTH GPU TRANSFORM)
    let syncInterval = null;
    let parsedLyrics = []; // [{ time: number, element: HTMLElement }]
    let lastActiveIndex = -1;
    let currentFetchController = null;
    const lyricsCache = new Map(); // Cache lyrics: "artist:title" -> data
    let mxmToken = null;

    function initLyrics() {
        if (!Spicetify.Player || !Spicetify.Player.data) {
            setTimeout(initLyrics, 500);
            return;
        }

        // Check if sidebar lyrics container exists every 3s
        setInterval(() => {
            if (!document.getElementById('custom-sidebar-lyrics')) {
                injectLyricsContainer();
            }
        }, 3000);

        // Update lyrics on song change
        Spicetify.Player.addEventListener("songchange", () => {
            injectLyricsContainer();
            updateSidebarLyrics();
        });

        // Handle play/pause
        Spicetify.Player.addEventListener("onplaypause", () => {
            if (Spicetify.Player.isPlaying() && !syncInterval && parsedLyrics.length > 0) {
                startLyricsSync();
            } else if (typeof updateLyricsPosition === 'function') {
                updateLyricsPosition(true);
            }
        });

        // Handle seek (rewind / fast-forward)
        Spicetify.Player.addEventListener("onseek", () => {
            if (typeof updateLyricsPosition === 'function') {
                updateLyricsPosition(true);
            }
        });

        injectLyricsContainer();
    }

    function stopLyricsSync() {
        if (syncInterval) {
            clearInterval(syncInterval);
            syncInterval = null;
        }
    }

    function injectLyricsContainer() {
        const sidebar = document.querySelector('aside[data-testid="now-playing-panel"]') ||
                        document.querySelector('.main-nowPlayingView-container') ||
                        document.querySelector('aside');
        if (!sidebar) {
            stopLyricsSync();
            return false;
        }

        const panelContainer = sidebar.querySelector('.main-nowPlayingView-panel');
        if (!panelContainer) {
            stopLyricsSync();
            return false;
        }

        let lyricsDiv = document.getElementById('custom-sidebar-lyrics');
        if (lyricsDiv) {
            const firstSection = Array.from(panelContainer.children).find(child => child.id !== 'custom-sidebar-lyrics');
            if (firstSection && lyricsDiv.previousElementSibling !== firstSection) {
                firstSection.after(lyricsDiv);
            }
            return true;
        }

        // Container with smooth top/bottom mask fade
        lyricsDiv = document.createElement('div');
        lyricsDiv.id = 'custom-sidebar-lyrics';
        lyricsDiv.className = 'main-nowPlayingView-section';
        lyricsDiv.style.overflow = 'hidden';
        lyricsDiv.style.position = 'relative';
        lyricsDiv.style.backgroundColor = 'transparent';
        lyricsDiv.style.fontFamily = 'spotify-circular, sans-serif';
        lyricsDiv.style.margin = '-4px 0 4px 0';
        lyricsDiv.style.padding = '0';
        lyricsDiv.style.display = 'block';

        // Ultra-sharp top mask fade (0-5px) to instantly cut off previous lines while keeping active line 100% visible
        lyricsDiv.style.webkitMaskImage = 'linear-gradient(to bottom, transparent 0px, black 5px, black 85%, transparent 100%)';
        lyricsDiv.style.maskImage = 'linear-gradient(to bottom, transparent 0px, black 5px, black 85%, transparent 100%)';

        // Inner smooth transform wrapper
        const wrapperDiv = document.createElement('div');
        wrapperDiv.id = 'custom-sidebar-lyrics-wrapper';
        wrapperDiv.style.transition = 'transform 0.45s cubic-bezier(0.2, 1, 0.3, 1)';
        wrapperDiv.style.transform = 'translate3d(0, 0px, 0)';
        lyricsDiv.appendChild(wrapperDiv);

        const firstSection = Array.from(panelContainer.children).find(child => child.id !== 'custom-sidebar-lyrics');
        if (firstSection) {
            firstSection.after(lyricsDiv);
        } else {
            panelContainer.appendChild(lyricsDiv);
        }
        updateSidebarLyrics();
        return true;
    }

    function getKey(artist, title) {
        return `${artist.toLowerCase().trim()}:${title.toLowerCase().trim()}`;
    }

    async function getMxmToken(signal) {
        if (mxmToken) return mxmToken;
        try {
            const res = await fetch("https://apic-desktop.musixmatch.com/ws/1.1/token.get?app_id=web-desktop-app-v1.0", { signal });
            const json = await res.json();
            if (json.message?.header?.status_code === 200) {
                mxmToken = json.message.body.user_token;
                return mxmToken;
            }
        } catch (_) {}
        return null;
    }

    async function fetchFromMusixmatch(artist, title, durationSec, signal) {
        try {
            const token = await getMxmToken(signal);
            if (!token) return null;

            const durParam = durationSec ? `&f_has_lyrics=1&q_duration=${Math.round(durationSec)}` : '';
            const searchUrl = `https://apic-desktop.musixmatch.com/ws/1.1/macro.subtitles.get?format=json&q_artist=${encodeURIComponent(artist)}&q_track=${encodeURIComponent(title)}${durParam}&user_token=${encodeURIComponent(token)}&app_id=web-desktop-app-v1.0`;

            const res = await fetch(searchUrl, { signal });
            if (!res.ok) return null;
            const json = await res.json();

            const body = json.message?.body?.macro_result_list;
            if (!body) return null;

            const subList = body.subtitles_list || body.track_list?.[0]?.track?.subtitle;
            const rawSub = body.subtitle?.subtitle_body || subList?.[0]?.subtitle?.subtitle_body;
            if (rawSub) {
                const parsed = JSON.parse(rawSub);
                const lrc = parsed.map(item => {
                    const total = item.time.total;
                    const m = Math.floor(total / 60).toString().padStart(2, '0');
                    const s = (total % 60).toFixed(2).padStart(5, '0');
                    return `[${m}:${s}]${item.text || '♪'}`;
                }).join('\n');

                return { syncedLyrics: lrc, plainLyrics: null };
            }

            const plainBody = body.lyrics?.lyrics_body || body.track_list?.[0]?.track?.lyrics?.lyrics_body;
            if (plainBody) {
                return { syncedLyrics: null, plainLyrics: plainBody };
            }
        } catch (_) {}
        return null;
    }

    async function fetchFromLrclib(artist, title, durationSec, signal) {
        try {
            const durParam = durationSec ? `&duration=${Math.round(durationSec)}` : '';
            const url = `https://lrclib.net/api/get?artist_name=${encodeURIComponent(artist)}&track_name=${encodeURIComponent(title)}${durParam}`;
            const res = await fetch(url, { signal });
            if (!res.ok) return null;
            return await res.json();
        } catch (_) {
            return null;
        }
    }

    async function fetchLyricsData(artist, title, durationSec, signal) {
        const key = getKey(artist, title);
        if (lyricsCache.has(key)) {
            return lyricsCache.get(key);
        }

        // Primary: LRCLIB
        let data = await fetchFromLrclib(artist, title, durationSec, signal);

        // Fallback: Musixmatch
        if (!data || (!data.syncedLyrics && !data.plainLyrics)) {
            const mxmData = await fetchFromMusixmatch(artist, title, durationSec, signal);
            if (mxmData) {
                data = mxmData;
            }
        }

        lyricsCache.set(key, data || null);
        return data;
    }

    async function prefetchNextLyrics() {
        try {
            const queue = Spicetify.Queue;
            if (!queue) return;
            const nextTracks = queue.nextTracks || queue.next_tracks;
            if (!nextTracks || nextTracks.length === 0) return;

            const nextItem = nextTracks[0];
            const artist = nextItem.contextTrack?.metadata?.artist_name || nextItem.artist?.name || nextItem.artists?.[0]?.name;
            const title = nextItem.contextTrack?.metadata?.title || nextItem.name || nextItem.title;
            const durationSec = (nextItem.contextTrack?.metadata?.duration || 0) / 1000;

            if (artist && title) {
                const key = getKey(artist, title);
                if (!lyricsCache.has(key)) {
                    await fetchLyricsData(artist, title, durationSec);
                }
            }
        } catch (e) {
            // Ignore queue prefetch errors silently
        }
    }

    async function updateSidebarLyrics() {
        const wrapper = document.getElementById('custom-sidebar-lyrics-wrapper');
        if (!wrapper) return;

        if (currentFetchController) {
            currentFetchController.abort();
        }
        currentFetchController = new AbortController();

        stopLyricsSync();
        parsedLyrics = [];
        lastActiveIndex = -1;

        const metadata = Spicetify.Player.data?.item?.metadata;
        if (!metadata) {
            wrapper.innerText = 'No track information';
            return;
        }

        const artist = metadata.artist_name || '';
        const title = metadata.title || '';
        const durationSec = (Spicetify.Player.getDuration() || parseInt(metadata.duration || 0, 10)) / 1000;
        const key = getKey(artist, title);

        prefetchNextLyrics();

        if (lyricsCache.has(key)) {
            const cachedData = lyricsCache.get(key);
            renderLyrics(cachedData, wrapper);
            return;
        }

        wrapper.textContent = '';
        const loadingDiv = document.createElement('div');
        loadingDiv.style.cssText = 'opacity: 0.5; font-size: 16px; padding: 20px 0; font-weight: bold; text-align: center;';
        loadingDiv.textContent = 'Searching for lyrics...';
        wrapper.appendChild(loadingDiv);
        wrapper.style.transform = 'translate3d(0, 20px, 0)';

        try {
            const data = await fetchLyricsData(artist, title, durationSec, currentFetchController.signal);
            renderLyrics(data, wrapper);
        } catch (err) {
            if (err.name !== 'AbortError') {
                wrapper.textContent = '';
                const errDiv = document.createElement('div');
                errDiv.style.cssText = 'opacity: 0.5; font-size: 16px; padding: 20px 0; font-weight: bold; text-align: center;';
                errDiv.textContent = 'Error loading lyrics';
                wrapper.appendChild(errDiv);
            }
        }
    }

    function renderLyrics(data, wrapper) {
        if (!data) {
            wrapper.textContent = '';
            const notFoundDiv = document.createElement('div');
            notFoundDiv.style.cssText = 'opacity: 0.5; font-size: 16px; padding: 20px 0; font-weight: bold; text-align: center;';
            notFoundDiv.textContent = 'No lyrics found';
            wrapper.appendChild(notFoundDiv);
            return;
        }

        if (data.syncedLyrics) {
            wrapper.textContent = '';
            const fragment = document.createDocumentFragment();
            const lines = data.syncedLyrics.split('\n');

            lines.forEach(line => {
                const match = line.match(/\[(\d+):(\d+\.\d+)\](.*)/);
                if (match) {
                    const min = parseInt(match[1], 10);
                    const sec = parseFloat(match[2]);
                    const time = min * 60 + sec;
                    const text = match[3].trim();

                    const p = document.createElement('p');
                    p.className = 'sidebar-lyric-line';
                    p.textContent = text || '♪';
                    p.style.cssText = 'margin:0; padding:5px 0; font-size:20px; font-weight:800; line-height:1.3; color:#ffffff; opacity:0.25; transition:opacity 0.35s ease;';
                    fragment.appendChild(p);

                    parsedLyrics.push({ time, element: p });
                }
            });

            wrapper.appendChild(fragment);
            startLyricsSync();

        } else if (data.plainLyrics) {
            wrapper.textContent = '';
            const plainDiv = document.createElement('div');
            plainDiv.style.cssText = 'font-size: 16px; line-height: 1.5; font-weight: bold; white-space: pre-wrap; padding: 20px 0;';
            plainDiv.textContent = data.plainLyrics;
            wrapper.appendChild(plainDiv);
        } else {
            wrapper.textContent = '';
            const notFoundDiv = document.createElement('div');
            notFoundDiv.style.cssText = 'opacity: 0.5; font-size: 16px; padding: 20px 0; font-weight: bold; text-align: center;';
            notFoundDiv.textContent = 'No lyrics found';
            wrapper.appendChild(notFoundDiv);
        }
    }

    let updateLyricsPosition = (force = false) => {};

    function startLyricsSync() {
        stopLyricsSync();
        const wrapper = document.getElementById('custom-sidebar-lyrics-wrapper');

        updateLyricsPosition = (force = false) => {
            if (!wrapper || !wrapper.isConnected || parsedLyrics.length === 0) {
                stopLyricsSync();
                return;
            }

            const progress = Spicetify.Player.getProgress() / 1000;
            let activeIndex = -1;

            for (let i = 0; i < parsedLyrics.length; i++) {
                if (progress >= parsedLyrics[i].time) {
                    activeIndex = i;
                } else {
                    break;
                }
            }

            if (force || activeIndex !== lastActiveIndex) {
                if (lastActiveIndex !== -1 && parsedLyrics[lastActiveIndex]) {
                    parsedLyrics[lastActiveIndex].element.style.opacity = '0.25';
                }
                if (activeIndex !== -1 && parsedLyrics[activeIndex]) {
                    const activeEl = parsedLyrics[activeIndex].element;
                    activeEl.style.opacity = '1.0';

                    // Position active line top exactly at 0px right underneath track info header
                    const targetY = 0 - activeEl.offsetTop;

                    // Hardware GPU accelerated smooth transition triggered ONLY on line change
                    wrapper.style.transform = `translate3d(0, ${targetY}px, 0)`;
                }
                lastActiveIndex = activeIndex;
            }
        };

        // Run immediately with force = true to position on correct line right after loading
        updateLyricsPosition(true);

        syncInterval = setInterval(() => {
            updateLyricsPosition();
        }, 300);
    }

    initLyrics();
})();
