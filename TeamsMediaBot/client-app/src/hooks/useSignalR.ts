import { useState, useEffect, useCallback, useRef } from 'react';
import * as signalR from '@microsoft/signalr';
import { Caption, SessionInfo } from '../types';

interface UseSignalRResult {
  isConnected: boolean;
  captions: Caption[];
  currentPartial: Caption | null;
  error: string | null;
  connect: (sessionId: string, channelId: string) => Promise<void>;
  disconnect: () => Promise<void>;
}

export function useSignalR(hubUrl: string): UseSignalRResult {
  const [isConnected, setIsConnected] = useState(false);
  const [captions, setCaptions] = useState<Caption[]>([]);
  const [currentPartial, setCurrentPartial] = useState<Caption | null>(null);
  const [error, setError] = useState<string | null>(null);

  const connectionRef = useRef<signalR.HubConnection | null>(null);
  const sessionRef = useRef<{ sessionId: string; channelId: string } | null>(null);
  const captionIdCounter = useRef(0);

  const connect = useCallback(async (sessionId: string, channelId: string) => {
    if (connectionRef.current?.state === signalR.HubConnectionState.Connected) {
      // Already connected, just join the new session
      try {
        if (sessionRef.current) {
          await connectionRef.current.invoke('LeaveSession', sessionRef.current.sessionId, sessionRef.current.channelId);
        }
        await connectionRef.current.invoke('JoinSession', sessionId, channelId);
        sessionRef.current = { sessionId, channelId };
        return;
      } catch (err) {
        console.error('Failed to join session:', err);
      }
    }

    try {
      const connection = new signalR.HubConnectionBuilder()
        .withUrl(hubUrl)
        .withAutomaticReconnect([0, 2000, 5000, 10000, 30000])
        .configureLogging(signalR.LogLevel.Information)
        .build();

      // Handle incoming captions
      connection.on('ReceiveCaption', (caption: Omit<Caption, 'id'>) => {
        const captionWithId: Caption = {
          ...caption,
          id: `caption-${++captionIdCounter.current}`,
        };

        if (caption.isFinal) {
          // Add final caption to the list and clear partial
          setCaptions(prev => [...prev, captionWithId].slice(-100)); // Keep last 100 captions
          setCurrentPartial(null);
        } else {
          // Update the current partial caption
          setCurrentPartial(captionWithId);
        }
      });

      // Handle connection events
      connection.onreconnecting(() => {
        console.log('SignalR reconnecting...');
        setIsConnected(false);
      });

      connection.onreconnected(async () => {
        console.log('SignalR reconnected');
        setIsConnected(true);
        // Rejoin the session after reconnection
        if (sessionRef.current) {
          try {
            await connection.invoke('JoinSession', sessionRef.current.sessionId, sessionRef.current.channelId);
          } catch (err) {
            console.error('Failed to rejoin session after reconnect:', err);
          }
        }
      });

      connection.onclose(() => {
        console.log('SignalR connection closed');
        setIsConnected(false);
      });

      // Start the connection
      await connection.start();
      console.log('SignalR connected');

      // Join the session
      await connection.invoke('JoinSession', sessionId, channelId);
      console.log(`Joined session ${sessionId}/${channelId}`);

      connectionRef.current = connection;
      sessionRef.current = { sessionId, channelId };
      setIsConnected(true);
      setError(null);
    } catch (err) {
      console.error('Failed to connect to SignalR:', err);
      setError(err instanceof Error ? err.message : 'Failed to connect');
      setIsConnected(false);
    }
  }, [hubUrl]);

  const disconnect = useCallback(async () => {
    if (connectionRef.current) {
      try {
        if (sessionRef.current && connectionRef.current.state === signalR.HubConnectionState.Connected) {
          await connectionRef.current.invoke('LeaveSession', sessionRef.current.sessionId, sessionRef.current.channelId);
        }
        await connectionRef.current.stop();
      } catch (err) {
        console.error('Error disconnecting:', err);
      }
      connectionRef.current = null;
      sessionRef.current = null;
      setIsConnected(false);
    }
  }, []);

  // Cleanup on unmount
  useEffect(() => {
    return () => {
      disconnect();
    };
  }, [disconnect]);

  return { isConnected, captions, currentPartial, error, connect, disconnect };
}

// Helper function to fetch session info by threadId
export async function fetchSessionByThreadId(threadId: string): Promise<SessionInfo | null> {
  try {
    const response = await fetch(`/api/captions/session?threadId=${encodeURIComponent(threadId)}`);
    if (!response.ok) {
      if (response.status === 404) {
        return null;
      }
      throw new Error(`HTTP error: ${response.status}`);
    }
    return await response.json();
  } catch (err) {
    console.error('Failed to fetch session:', err);
    return null;
  }
}
