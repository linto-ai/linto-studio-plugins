import { useState, useEffect } from 'react';
import * as microsoftTeams from '@microsoft/teams-js';
import { MeetingContext } from '../types';

type TeamsTheme = 'default' | 'dark' | 'contrast';

interface TeamsContextResult {
  isInitialized: boolean;
  isInTeams: boolean;
  theme: TeamsTheme;
  meetingContext: MeetingContext | null;
  error: string | null;
}

export function useTeamsContext(): TeamsContextResult {
  const [isInitialized, setIsInitialized] = useState(false);
  const [isInTeams, setIsInTeams] = useState(false);
  const [theme, setTheme] = useState<TeamsTheme>('default');
  const [meetingContext, setMeetingContext] = useState<MeetingContext | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    const initializeTeams = async () => {
      try {
        // Initialize the Teams SDK
        await microsoftTeams.app.initialize();
        setIsInTeams(true);

        // Get the current context
        const context = await microsoftTeams.app.getContext();

        // Set the theme
        const currentTheme = context.app.theme as TeamsTheme;
        setTheme(currentTheme || 'default');
        applyTheme(currentTheme || 'default');

        // Get meeting context
        if (context.meeting) {
          setMeetingContext({
            meetingId: context.meeting.id,
          });
        }

        // Also get the chat/conversation context which has the threadId
        if (context.chat) {
          setMeetingContext(prev => ({
            ...prev,
            conversationId: context.chat?.id,
            threadId: context.chat?.id, // In meetings, chat.id is the threadId
          }));
        }

        // Register theme change handler
        microsoftTeams.app.registerOnThemeChangeHandler((newTheme) => {
          setTheme(newTheme as TeamsTheme || 'default');
          applyTheme(newTheme as TeamsTheme || 'default');
        });

        // Notify Teams that the app is ready
        microsoftTeams.app.notifySuccess();

        setIsInitialized(true);
      } catch (err) {
        console.error('Failed to initialize Teams SDK:', err);
        setError(err instanceof Error ? err.message : 'Failed to initialize Teams');
        setIsInTeams(false);
        setIsInitialized(true);

        // For development outside Teams, use URL params
        const params = new URLSearchParams(window.location.search);
        const threadId = params.get('threadId');
        const sessionId = params.get('sessionId');
        const channelId = params.get('channelId');

        if (threadId || (sessionId && channelId)) {
          setMeetingContext({
            threadId: threadId || undefined,
          });
        }
      }
    };

    initializeTeams();
  }, []);

  return { isInitialized, isInTeams, theme, meetingContext, error };
}

function applyTheme(theme: TeamsTheme) {
  document.body.classList.remove('light', 'dark', 'contrast');
  switch (theme) {
    case 'dark':
      document.body.classList.add('dark');
      break;
    case 'contrast':
      document.body.classList.add('contrast');
      break;
    default:
      document.body.classList.add('light');
  }
}
