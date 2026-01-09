import { useEffect, useRef } from 'react';
import { Caption } from '../types';
import './CaptionsPanel.css';

interface CaptionsPanelProps {
  captions: Caption[];
  currentPartial: Caption | null;
  isConnected: boolean;
}

export function CaptionsPanel({ captions, currentPartial, isConnected }: CaptionsPanelProps) {
  const containerRef = useRef<HTMLDivElement>(null);

  // Auto-scroll to bottom when new captions arrive
  useEffect(() => {
    if (containerRef.current) {
      containerRef.current.scrollTop = containerRef.current.scrollHeight;
    }
  }, [captions, currentPartial]);

  return (
    <div className="captions-panel">
      <div className="captions-header">
        <span className="captions-title">Live Captions</span>
        <span className={`connection-status ${isConnected ? 'connected' : 'disconnected'}`}>
          {isConnected ? '● Connected' : '○ Disconnected'}
        </span>
      </div>

      <div className="captions-container" ref={containerRef}>
        {captions.length === 0 && !currentPartial && (
          <div className="captions-empty">
            Waiting for transcriptions...
          </div>
        )}

        {captions.map((caption) => (
          <CaptionItem key={caption.id} caption={caption} />
        ))}

        {currentPartial && (
          <CaptionItem caption={currentPartial} isPartial />
        )}
      </div>
    </div>
  );
}

interface CaptionItemProps {
  caption: Caption;
  isPartial?: boolean;
}

function CaptionItem({ caption, isPartial = false }: CaptionItemProps) {
  const speakerName = caption.speakerId || 'Speaker';
  const timestamp = new Date(caption.timestamp).toLocaleTimeString([], {
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
  });

  return (
    <div className={`caption-item ${isPartial ? 'partial' : 'final'}`}>
      <div className="caption-header">
        <span className="caption-speaker">{speakerName}</span>
        <span className="caption-time">{timestamp}</span>
      </div>
      <div className="caption-text">
        {caption.text}
        {isPartial && <span className="typing-indicator">...</span>}
      </div>
      {caption.translations && Object.keys(caption.translations).length > 0 && (
        <div className="caption-translations">
          {Object.entries(caption.translations).map(([lang, text]) => (
            <div key={lang} className="translation">
              <span className="translation-lang">[{lang}]</span> {text}
            </div>
          ))}
        </div>
      )}
    </div>
  );
}
