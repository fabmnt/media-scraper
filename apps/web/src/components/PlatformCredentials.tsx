import { useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MAX_CREDENTIAL_LENGTH,
  PLATFORM_CREDENTIALS,
  PLATFORM_LABELS,
  type Platform,
} from '@media-scraper/shared';
import { api } from '../api';
import { queryKeys } from '../query-keys';
import { CredentialLoginDialog } from './CredentialLoginDialog';

const PLATFORM_DETAILS = {
  instagram: {
    placeholder: 'sessionid=...; csrftoken=...; ds_user_id=...',
  },
  facebook: {
    placeholder: 'c_user=...; xs=...; datr=...',
  },
  tiktok: {
    placeholder: 'sid_tt=...; tt_csrf_token=...; passport_csrf_token=...',
  },
} as const satisfies Record<Platform, { placeholder: string }>;

export function PlatformCredentials({ platform }: { platform: Platform }) {
  const [cookies, setCookies] = useState('');
  const [fileError, setFileError] = useState<string>();
  const [loginOpen, setLoginOpen] = useState(false);
  const fileInput = useRef<HTMLInputElement>(null);
  const fileSelection = useRef(0);
  const queryClient = useQueryClient();
  const queryKey = queryKeys.credential(platform);
  const label = PLATFORM_LABELS[platform];
  const details = PLATFORM_DETAILS[platform];
  const status = useQuery({
    queryKey,
    queryFn: () => api.getCredential(platform),
  });
  const session = status.data?.session ?? null;
  const sessionExpired = session?.status === 'expired';
  const save = useMutation({
    mutationFn: (value: string) => api.saveCredential(platform, value),
    onSuccess: async () => {
      setCookies('');
      if (fileInput.current) fileInput.current.value = '';
      await queryClient.invalidateQueries({ queryKey });
    },
  });
  const remove = useMutation({
    mutationFn: () => api.deleteCredential(platform),
    onSuccess: async () => {
      await queryClient.invalidateQueries({ queryKey });
    },
  });

  async function selectFile(event: ChangeEvent<HTMLInputElement>) {
    const file = event.target.files?.[0];
    if (!file) return;
    const selection = fileSelection.current + 1;
    fileSelection.current = selection;
    setFileError(undefined);
    setCookies('');
    if (file.size > MAX_CREDENTIAL_LENGTH) {
      setFileError('Cookie file is too large');
      return;
    }
    try {
      const content = await file.text();
      if (fileSelection.current === selection) setCookies(content);
    } catch {
      if (fileSelection.current === selection) {
        setFileError('Cookie file could not be read');
      }
    }
  }

  return (
    <details className="credentials">
      <summary>
        <span>
          <span className="eyebrow">{label.toUpperCase()} ACCESS</span>
          <strong>Authenticated session</strong>
        </span>
        <span
          className={`credential-state ${sessionExpired ? 'expired' : status.data?.configured ? 'configured' : ''}`}
        >
          {status.isLoading
            ? 'Checking…'
            : status.error
              ? 'Unavailable'
              : sessionExpired
                ? 'Session expired'
                : status.data?.configured
                  ? 'Configured'
                  : 'Not configured'}
        </span>
      </summary>
      <div className="credentials-body">
        {sessionExpired && (
          <p className="credential-session-warning" role="alert">
            {session.message ??
              `The ${label} session has expired or been revoked.`}{' '}
            Detected{' '}
            {new Date(session.detectedAt).toLocaleString(undefined, {
              dateStyle: 'medium',
              timeStyle: 'short',
            })}
            .
          </p>
        )}
        <p>
          Paste a {label} Cookie header or select a Netscape cookies.txt export.
          It must contain{' '}
          {PLATFORM_CREDENTIALS[platform].requiredCookies.join(' and ')}. The
          credential stays on this machine and is never returned by the API.
        </p>
        <textarea
          aria-label={`${label} cookies`}
          autoComplete="off"
          onChange={(event) => {
            fileSelection.current += 1;
            setFileError(undefined);
            setCookies(event.target.value);
          }}
          placeholder={details.placeholder}
          spellCheck={false}
          value={cookies}
        />
        <div className="credential-actions">
          {status.data?.interactiveLogin && (
            <button onClick={() => setLoginOpen(true)} type="button">
              Sign in with browser
            </button>
          )}
          <label className="file-button">
            Select cookies.txt
            <input
              accept=".txt,text/plain"
              onChange={(event) => void selectFile(event)}
              ref={fileInput}
              type="file"
            />
          </label>
          <button
            disabled={!cookies.trim() || save.isPending || remove.isPending}
            onClick={() => save.mutate(cookies)}
            type="button"
          >
            {save.isPending
              ? 'Saving…'
              : sessionExpired
                ? 'Replace credential'
                : 'Save credential'}
          </button>
          {status.data?.configured && (
            <button
              className="danger-button"
              disabled={remove.isPending || save.isPending}
              onClick={() => {
                if (window.confirm(`Remove the stored ${label} credential?`)) {
                  remove.mutate();
                }
              }}
              type="button"
            >
              Remove
            </button>
          )}
        </div>
        {(status.error || save.error || remove.error || fileError) && (
          <p className="error">
            {fileError ?? (status.error ?? save.error ?? remove.error)?.message}
          </p>
        )}
        <small>
          Treat session cookies like a password. Logging out of {label} or
          changing your password can invalidate them.
          {session?.status === 'valid' &&
            ` Last verified working ${new Date(session.detectedAt).toLocaleString(undefined, { dateStyle: 'medium', timeStyle: 'short' })}.`}
        </small>
      </div>
      {loginOpen && (
        <CredentialLoginDialog
          onClose={() => setLoginOpen(false)}
          onCompleted={() => {
            setLoginOpen(false);
            void queryClient.invalidateQueries({ queryKey });
          }}
          platform={platform}
        />
      )}
    </details>
  );
}
