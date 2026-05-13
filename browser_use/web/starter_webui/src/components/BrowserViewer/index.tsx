import { useEffect, useRef, useState, useCallback } from 'react';
import { Maximize2, Minimize2, ZoomIn, ZoomOut, Monitor } from 'lucide-react';

// @ts-ignore – noVNC has no bundled type declarations
import RFB from '@novnc/novnc/lib/rfb';

interface BrowserViewerProps {
  /** WebSocket URL for the sandbox livestream (vnc_url from metadata) */
  vncUrl: string | null;
}

export default function BrowserViewer({ vncUrl }: BrowserViewerProps) {
  const screenRef    = useRef<HTMLDivElement>(null);
  const containerRef = useRef<HTMLDivElement>(null);
  const rfbRef       = useRef<any>(null);

  const [connected, setConnected]     = useState(false);
  const [scale, setScale]             = useState(1);
  const [isFullscreen, setIsFullscreen] = useState(false);

  // Use the dynamic URL received from chat metadata
  const effectiveUrl = vncUrl;

  // ── noVNC connection ──────────────────────────────────────────────────────
  useEffect(() => {
    if (!effectiveUrl || !screenRef.current) return;

    console.log('[BrowserViewer] connecting via noVNC to:', effectiveUrl);

    // Tear down any existing connection
    if (rfbRef.current) {
      rfbRef.current.disconnect();
      rfbRef.current = null;
    }
    // Clear the container so noVNC can attach a fresh canvas
    screenRef.current.innerHTML = '';

    try {
      const rfb = new RFB(screenRef.current, effectiveUrl);
      rfbRef.current = rfb;

      rfb.scaleViewport = true;   // auto-scale to container
      rfb.resizeSession = false;
      rfb.viewOnly      = true;   // read-only – agent controls the browser

      rfb.addEventListener('connect', () => {
        console.log('[BrowserViewer] noVNC connected');
        setConnected(true);
      });

      rfb.addEventListener('disconnect', (evt: CustomEvent) => {
        const clean = (evt as any).detail?.clean;
        console.log('[BrowserViewer] noVNC disconnected, clean=', clean);
        setConnected(false);
        rfbRef.current = null;
      });

      rfb.addEventListener('credentialsrequired', () => {
        console.warn('[BrowserViewer] VNC credentials required – sending empty password');
        rfb.sendCredentials({ password: '' });
      });
    } catch (err) {
      console.error('[BrowserViewer] noVNC init error', err);
    }

    return () => {
      if (rfbRef.current) {
        rfbRef.current.disconnect();
        rfbRef.current = null;
      }
      setConnected(false);
    };
  }, [effectiveUrl]);

  // ── Fullscreen ────────────────────────────────────────────────────────────
  const handleFullscreen = useCallback(() => {
    if (!containerRef.current) return;
    if (!document.fullscreenElement) {
      containerRef.current.requestFullscreen().then(() => setIsFullscreen(true)).catch(() => {});
    } else {
      document.exitFullscreen().then(() => setIsFullscreen(false)).catch(() => {});
    }
  }, []);

  useEffect(() => {
    const handler = () => { if (!document.fullscreenElement) setIsFullscreen(false); };
    document.addEventListener('fullscreenchange', handler);
    return () => document.removeEventListener('fullscreenchange', handler);
  }, []);

  // ── Zoom ──────────────────────────────────────────────────────────────────
  const zoomOut   = useCallback(() => setScale(s => Math.max(0.25, parseFloat((s - 0.25).toFixed(2)))), []);
  const zoomIn    = useCallback(() => setScale(s => Math.min(4,    parseFloat((s + 0.25).toFixed(2)))), []);
  const zoomReset = useCallback(() => setScale(1), []);

  // When scale changes, update the noVNC canvas wrapper
  useEffect(() => {
    if (!screenRef.current) return;
    const canvas = screenRef.current.querySelector('canvas');
    if (canvas) {
      (canvas.parentElement as HTMLElement).style.transform = `scale(${scale})`;
      (canvas.parentElement as HTMLElement).style.transformOrigin = 'top left';
    }
  }, [scale]);

  // ── Placeholder ───────────────────────────────────────────────────────────
  if (!effectiveUrl) {
    return (
      <div style={styles.placeholder}>
        <Monitor size={40} color="#444" />
        <p style={{ color: '#555', marginTop: 12, fontSize: 13 }}>
          Browser viewer will appear here once a session starts
        </p>
      </div>
    );
  }

  return (
    <div ref={containerRef} style={styles.root}>
      {/* Toolbar */}
      <div style={styles.toolbar}>
        <span style={{ ...styles.dot, background: connected ? '#52c41a' : '#ff4d4f' }} />
        <span style={styles.statusText}>
          {connected ? 'VNC Connected' : 'Connecting…'}
        </span>

        <div style={{ flex: 1 }} />

        {/* Zoom controls */}
        <button style={styles.btn} title="Zoom out" onClick={zoomOut}>
          <ZoomOut size={13} />
        </button>
        <button style={{ ...styles.btn, minWidth: 42, fontSize: 11 }} title="Reset zoom" onClick={zoomReset}>
          {Math.round(scale * 100)}%
        </button>
        <button style={styles.btn} title="Zoom in" onClick={zoomIn}>
          <ZoomIn size={13} />
        </button>

        {/* Fullscreen */}
        <button style={styles.btn} title={isFullscreen ? 'Exit fullscreen' : 'Fullscreen'} onClick={handleFullscreen}>
          {isFullscreen ? <Minimize2 size={13} /> : <Maximize2 size={13} />}
        </button>
      </div>

      {/* noVNC renders a <canvas> inside this div */}
      <div
        ref={screenRef}
        style={styles.screen}
      />
    </div>
  );
}

const styles: Record<string, React.CSSProperties> = {
  root: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    background: '#0d0d14',
    overflow: 'hidden',
  },
  placeholder: {
    height: '100%',
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    background: '#0d0d14',
  },
  toolbar: {
    display: 'flex',
    alignItems: 'center',
    gap: 6,
    padding: '5px 10px',
    background: '#161624',
    borderBottom: '1px solid #2a2a3e',
    flexShrink: 0,
  },
  dot: {
    width: 8,
    height: 8,
    borderRadius: '50%',
    flexShrink: 0,
  },
  statusText: {
    color: '#888',
    fontSize: 11,
    whiteSpace: 'nowrap',
  },
  btn: {
    background: 'transparent',
    border: '1px solid #2a2a3e',
    borderRadius: 4,
    color: '#aaa',
    cursor: 'pointer',
    padding: '2px 6px',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
  },
  screen: {
    flex: 1,
    overflow: 'auto',
    background: '#000',
    // noVNC appends a <canvas> here; give it room
    position: 'relative',
  },
};
