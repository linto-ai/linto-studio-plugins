import { useEffect, useState } from 'react';
import { useTeamsContext } from './hooks/useTeamsContext';
import { useSignalR, fetchSessionByThreadId } from './hooks/useSignalR';
import { CaptionsPanel } from './components/CaptionsPanel';
import { SessionInfo } from './types';
import './App.css';

// Get the SignalR hub URL from the current host
const getHubUrl = () => {
  const protocol = window.location.protocol;
  const host = window.location.host;
  return `${protocol}//${host}/hubs/captions`;
};

function App() {
  const { isInitialized, isInTeams, meetingContext, error: teamsError } = useTeamsContext();
  const { isConnected, captions, currentPartial, error: signalRError, connect } = useSignalR(getHubUrl());

  const [sessionInfo, setSessionInfo] = useState<SessionInfo | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);

  // Effect to load session info and connect to SignalR
  useEffect(() => {
    const loadSession = async () => {
      if (!isInitialized) return;

      setIsLoading(true);
      setLoadError(null);

      try {
        // First, check URL parameters (for dev/testing)
        const params = new URLSearchParams(window.location.search);
        const sessionIdParam = params.get('sessionId');
        const channelIdParam = params.get('channelId');

        if (sessionIdParam && channelIdParam) {
          // Direct session/channel specified in URL
          setSessionInfo({
            sessionId: sessionIdParam,
            channelId: channelIdParam,
            enableDisplaySub: true,
          });
          await connect(sessionIdParam, channelIdParam);
          setIsLoading(false);
          return;
        }

        // Try to get session by threadId
        const threadId = params.get('threadId') || meetingContext?.threadId;

        if (threadId) {
          const session = await fetchSessionByThreadId(threadId);
          if (session) {
            setSessionInfo(session);
            await connect(session.sessionId, session.channelId);
          } else {
            setLoadError('No active transcription session found for this meeting.');
          }
        } else if (!isInTeams) {
          setLoadError('Not running in Teams. Use URL parameters: ?sessionId=X&channelId=Y');
        } else {
          setLoadError('Unable to get meeting context from Teams.');
        }
      } catch (err) {
        console.error('Error loading session:', err);
        setLoadError(err instanceof Error ? err.message : 'Failed to load session');
      } finally {
        setIsLoading(false);
      }
    };

    loadSession();
  }, [isInitialized, meetingContext, connect, isInTeams]);

  // Retry loading session periodically if not found
  useEffect(() => {
    if (!sessionInfo && !isLoading && meetingContext?.threadId) {
      const retryInterval = setInterval(async () => {
        const session = await fetchSessionByThreadId(meetingContext.threadId!);
        if (session) {
          setSessionInfo(session);
          setLoadError(null);
          await connect(session.sessionId, session.channelId);
          clearInterval(retryInterval);
        }
      }, 5000); // Retry every 5 seconds

      return () => clearInterval(retryInterval);
    }
  }, [sessionInfo, isLoading, meetingContext, connect]);

  // Show loading state
  if (!isInitialized || isLoading) {
    return (
      <div className="app-container">
        <div className="status-message">
          <div className="spinner"></div>
          <p>Loading...</p>
        </div>
      </div>
    );
  }

  // Show error state
  if (loadError || teamsError || signalRError) {
    return (
      <div className="app-container">
        <div className="status-message error">
          <p className="error-title">Unable to load captions</p>
          <p className="error-message">{loadError || teamsError || signalRError}</p>
          {!sessionInfo && meetingContext?.threadId && (
            <p className="error-hint">
              Waiting for transcription bot to join the meeting...
            </p>
          )}
        </div>
      </div>
    );
  }

  // Show captions panel
  return (
    <div className="app-container">
      <CaptionsPanel
        captions={captions}
        currentPartial={currentPartial}
        isConnected={isConnected}
      />
    </div>
  );
}

export default App;
