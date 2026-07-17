import { useRef, useState, type ChangeEvent } from 'react';
import { useMutation, useQuery, useQueryClient } from '@tanstack/react-query';
import { MAX_CREDENTIAL_LENGTH } from '@media-scraper/shared';
import { api } from '../api';
import { queryKeys } from '../query-keys';

export function InstagramCredentials() {
  const [cookies, setCookies] = useState('');
  const [fileError, setFileError] = useState<string>();
  const fileInput = useRef<HTMLInputElement>(null);
  const fileSelection = useRef(0);
  const queryClient = useQueryClient();
  const status = useQuery({
    queryKey: queryKeys.instagramCredential,
    queryFn: api.getInstagramCredential,
  });
  const save = useMutation({
    mutationFn: api.saveInstagramCredential,
    onSuccess: async () => {
      setCookies('');
      if (fileInput.current) fileInput.current.value = '';
      await queryClient.invalidateQueries({
        queryKey: queryKeys.instagramCredential,
      });
    },
  });
  const remove = useMutation({
    mutationFn: api.deleteInstagramCredential,
    onSuccess: async () => {
      await queryClient.invalidateQueries({
        queryKey: queryKeys.instagramCredential,
      });
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
          <span className="eyebrow">INSTAGRAM ACCESS</span>
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
          Paste an Instagram Cookie header or select a Netscape cookies.txt
          export. The credential stays on this machine and is never returned by
          the API.
        </p>
        <textarea
          aria-label="Instagram cookies"
          autoComplete="off"
          onChange={(event) => setCookies(event.target.value)}
          placeholder="sessionid=...; csrftoken=...; ds_user_id=..."
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
                if (window.confirm('Remove the stored Instagram credential?')) {
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
          Treat session cookies like a password. Logging out of Instagram or
          changing your password can invalidate them.
        </small>
      </div>
    </details>
  );
}
