import { useState, type FormEvent } from 'react';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { api } from '../api';
import { queryKeys } from '../query-keys';

export function AccessGate() {
  const [token, setToken] = useState('');
  const queryClient = useQueryClient();
  const login = useMutation({
    mutationFn: api.login,
    onSuccess: (session) => {
      setToken('');
      queryClient.setQueryData(queryKeys.session, session);
    },
  });

  function submit(event: FormEvent) {
    event.preventDefault();
    login.mutate(token);
  }

  return (
    <main className="access-gate">
      <section className="collector">
        <div>
          <span className="eyebrow">PRIVATE ARCHIVE</span>
          <h1>Access Media Scraper</h1>
          <p>Enter the API access token configured for this installation.</p>
        </div>
        <form onSubmit={submit}>
          <input
            aria-label="Access token"
            autoComplete="current-password"
            onChange={(event) => setToken(event.target.value)}
            required
            type="password"
            value={token}
          />
          <button disabled={login.isPending} type="submit">
            {login.isPending ? 'Signing in…' : 'Sign in'}
          </button>
        </form>
        {login.error && <p className="error">{login.error.message}</p>}
      </section>
    </main>
  );
}
