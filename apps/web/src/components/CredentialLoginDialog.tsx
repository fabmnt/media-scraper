import { useCallback, useEffect, useRef, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import {
  PLATFORM_LABELS,
  type CredentialLoginSession,
  type Platform,
} from '@media-scraper/shared';
import { api } from '../api';
import { queryKeys } from '../query-keys';
import { CredentialLoginViewer } from './CredentialLoginViewer';

const LOGIN_SESSION_POLL_INTERVAL_MS = 2_000;

interface CredentialLoginDialogProps {
  onClose: () => void;
  onCompleted: () => void;
  platform: Platform;
}

export function CredentialLoginDialog({
  onClose,
  onCompleted,
  platform,
}: CredentialLoginDialogProps) {
  const dialogRef = useRef<HTMLDialogElement>(null);
  const [session, setSession] = useState<CredentialLoginSession>();
  const [startError, setStartError] = useState<string>();
  const [startAttempt, setStartAttempt] = useState(0);
  const [streamEnded, setStreamEnded] = useState(false);
  const [terminal, setTerminal] = useState(false);
  const label = PLATFORM_LABELS[platform];

  useEffect(() => {
    const dialog = dialogRef.current;
    const previousOverflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    dialog?.showModal();
    return () => {
      document.body.style.overflow = previousOverflow;
      if (dialog?.open) dialog.close();
    };
  }, []);

  useEffect(() => {
    let cancelled = false;
    setSession(undefined);
    setStartError(undefined);
    setStreamEnded(false);
    setTerminal(false);
    api
      .startCredentialLoginSession(platform)
      .then((startedSession) => {
        if (cancelled) {
          void api
            .deleteCredentialLoginSession(platform, startedSession.id)
            .catch(() => undefined);
          return;
        }
        setSession(startedSession);
      })
      .catch((error: unknown) => {
        if (!cancelled) {
          setStartError(
            error instanceof Error
              ? error.message
              : 'The sign-in session could not be started',
          );
        }
      });
    return () => {
      cancelled = true;
    };
  }, [platform, startAttempt]);

  const poll = useQuery({
    enabled: Boolean(session) && !terminal,
    queryFn: () => api.getCredentialLoginSession(platform, session?.id ?? ''),
    queryKey: queryKeys.credentialLoginSession(platform, session?.id ?? ''),
    refetchInterval: LOGIN_SESSION_POLL_INTERVAL_MS,
  });
  const status = poll.data?.status;

  useEffect(() => {
    if (terminal || (status !== 'completed' && status !== 'expired')) return;
    setTerminal(true);
    if (status === 'completed') onCompleted();
  }, [onCompleted, status, terminal]);

  useEffect(() => {
    return () => {
      if (session) {
        void api
          .deleteCredentialLoginSession(platform, session.id)
          .catch(() => undefined);
      }
    };
  }, [platform, session]);

  const handleStreamEnded = useCallback(() => setStreamEnded(true), []);
  const expired = status === 'expired';
  const failed = Boolean(startError) || expired || streamEnded;
  return (
    <dialog
      aria-label={`${label} sign-in`}
      className="login-dialog"
      onClose={onClose}
      ref={dialogRef}
    >
      <div className="login-dialog-header">
        <div>
          <span className="eyebrow">{label.toUpperCase()} ACCESS</span>
          <strong>Sign in with your browser</strong>
        </div>
        <button
          aria-label="Close sign-in"
          className="text-button"
          onClick={() => dialogRef.current?.close()}
          type="button"
        >
          Close
        </button>
      </div>
      <p className="login-dialog-hint">
        Log in on the official {label} page below — your password is entered
        there directly and is never stored here. When the sign-in completes,
        this window detects the session and saves it automatically.
      </p>
      {failed ? (
        <div className="login-dialog-status" role="alert">
          <p className="error">
            {startError ||
              (expired
                ? 'The sign-in session expired before login completed.'
                : 'The sign-in browser disconnected.')}
          </p>
          <button
            onClick={() => setStartAttempt((attempt) => attempt + 1)}
            type="button"
          >
            Try again
          </button>
        </div>
      ) : session ? (
        <CredentialLoginViewer
          onStreamEnded={handleStreamEnded}
          platform={platform}
          session={session}
        />
      ) : (
        <div className="login-dialog-status">
          <p>Starting the sign-in browser…</p>
        </div>
      )}
    </dialog>
  );
}
