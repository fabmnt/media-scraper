import { useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import {
  MAX_CREDENTIAL_LENGTH,
  PLATFORM_CREDENTIALS,
  type Platform,
} from '@media-scraper/shared';
import { api } from '../api';
import { queryKeys } from '../query-keys';

const PLATFORM_DETAILS = {
  instagram: {
    label: 'Instagram',
    placeholder: 'sessionid=...; csrftoken=...; ds_user_id=...',
  },
  facebook: {
    label: 'Facebook',
    placeholder: 'c_user=...; xs=...; datr=...',
  },
  tiktok: {
    label: 'TikTok',
    placeholder: 'sid_tt=...; tt_csrf_token=...; passport_csrf_token=...',
  },
} as const satisfies Record<Platform, { label: string; placeholder: string }>;

export function PlatformCredentials({ platform }: { platform: Platform }) {
  const [cookies, setCookies] = useState('');
  const [fileError, setFileError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const fileSelection = useRef(0);
  const queryClient = useQueryClient();
  const queryKey = queryKeys.credential(platform);
  const details = PLATFORM_DETAILS[platform];
  const status = useQuery({
    queryKey,
    queryFn: () => api.getCredential(platform),
  });
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
          <span className="eyebrow">{details.label.toUpperCase()} ACCESS</span>
          <strong>Authenticated session</strong>
        </span>
        <span
          className={`credential-state ${status.data?.configured ? 'configured' : ''}`}
        >
          {status.isLoading
            ? 'Checking…'
            : status.error
              ? 'Unavailable'
              : status.data?.configured
                ? 'Configured'
                : 'Not configured'}
        </span>
      </summary>
      <div className="credentials-body">
        <p>
          Paste a {details.label} Cookie header or select a Netscape cookies.txt
          export. It must contain{' '}
          {PLATFORM_CREDENTIALS[platform].requiredCookies.join(' and ')}. The
          credential stays on this machine and is never returned by the API.
        </p>
        <textarea
          aria-label={`${details.label} cookies`}
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
            {save.isPending ? 'Saving…' : 'Save credential'}
          </button>
          {status.data?.configured && (
            <button
              className="danger-button"
              disabled={remove.isPending || save.isPending}
              onClick={() => {
                if (
                  window.confirm(
                    `Remove the stored ${details.label} credential?`,
                  )
                ) {
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
          Treat session cookies like a password. Logging out of {details.label}
          or changing your password can invalidate them.
        </small>
      </div>
    </details>
  );
}
