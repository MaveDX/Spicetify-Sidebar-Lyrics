# Sidebar Lyrics for Spicetify

Synchronized lyrics rendered seamlessly inside Spotify's Right Sidebar (**Now Playing View**).

![Sidebar Lyrics Preview](preview.png)

## Overview & Features

- **Clean Sidebar Layout**: Automatically trims clutter (Artist Card, Song Credits, Merch, Tour Dates, etc.), keeping only current track info, lyrics, and Next in Queue.
- **Spotify Official Synced Lyrics**: Queries Spotify's native internal lyrics API first for exact track-aligned, non-censored line-synchronized lyrics.
- **Smart LRCLIB Fallback**: Automatically falls back to LRCLIB with strict duration tolerance (±4s) and explicit/clean filter matching to eliminate out-of-time edits and censored lyrics.
- **Strictly Synced**: Never displays unsynced/plain lyrics.
- **Click to Seek**: Click any lyric line to jump playback directly to that timestamp.
- **Smart Queue Prefetching**: Automatically prefetches upcoming queue tracks in the background for instant transitions.
- **Hardware-Accelerated Scrolling**: Uses 3D CSS transforms (`translate3d`) and opacity transitions for 60fps scrolling with zero CPU overhead.

## Installation

1. Copy `sidebar-lyrics.js` into your Spicetify extensions folder.
2. Enable and apply the extension via Spicetify CLI:
   ```bash
   spicetify config extensions sidebar-lyrics.js
   spicetify apply
   ```
