import { useEffect, useState } from 'react';
import { ConnectButton, useActiveAccount, useActiveWallet, useDisconnect } from 'thirdweb/react';
import { inAppWallet } from 'thirdweb/wallets';
import { Link, Route, Routes } from 'react-router-dom';
import { client } from './client.js';
import { authConfig } from './auth.js';
import { Apps } from './pages/Apps.js';
import { AppDetail } from './pages/AppDetail.js';
import { Admins } from './pages/Admins.js';

const wallets = [inAppWallet({ auth: { options: ['google', 'email'] } })];

/** Prominent hint shown when a connected wallet isn't whitelisted as admin. */
function NotAuthorized({ address }: { address: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const copy = (): void => {
    void navigator.clipboard?.writeText(address).then(() => {
      setCopied(true);
      setTimeout(() => setCopied(false), 1500);
    });
  };
  return (
    <div
      style={{
        border: '1px solid #e0b400',
        background: '#fff8e1',
        borderRadius: 8,
        padding: 20,
        marginTop: 16,
      }}
    >
      <h2 style={{ margin: '0 0 8px', fontSize: 18 }}>Wallet not authorized yet</h2>
      <p style={{ margin: '0 0 12px' }}>
        You signed in successfully, but this wallet isn&apos;t an admin. Add the
        address below to <code>ADMIN_WALLETS</code> on the server (or have an
        existing admin add it under <strong>Admins</strong>), then sign in again.
      </p>
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}>
        <code
          style={{
            fontSize: 15,
            background: '#fff',
            border: '1px solid #ddd',
            borderRadius: 6,
            padding: '8px 12px',
            wordBreak: 'break-all',
          }}
        >
          {address}
        </code>
        <button onClick={copy} style={{ padding: '8px 12px', cursor: 'pointer' }}>
          {copied ? 'Copied!' : 'Copy'}
        </button>
      </div>
    </div>
  );
}

export function App() {
  const account = useActiveAccount();
  const wallet = useActiveWallet();
  const { disconnect } = useDisconnect();
  const [authed, setAuthed] = useState(false);
  const [notAuthorized, setNotAuthorized] = useState<string | null>(null);

  // Reconcile our auth state with any existing token on first load (e.g. a page
  // refresh after a previous successful login).
  useEffect(() => {
    void authConfig.isLoggedIn().then(setAuthed);
  }, [account]);

  useEffect(() => {
    // A fresh sign-in attempt started — drop any stale "not authorized" banner.
    const onLoginStart = (): void => setNotAuthorized(null);
    // Backend rejected a valid signature: the wallet isn't whitelisted. Show its
    // address so the operator knows what to add as admin, and disconnect to
    // dismiss thirdweb's own "Signing In" modal instead of leaving the user on
    // an error dialog.
    const onNotAuthorized = (e: Event): void => {
      const address = (e as CustomEvent<{ address: string }>).detail?.address;
      if (address) setNotAuthorized(address);
      setAuthed(false);
      if (wallet) disconnect(wallet);
    };
    // Login succeeded — clear any stale "not authorized" hint and enter the app.
    const onAuthorized = (): void => {
      setNotAuthorized(null);
      setAuthed(true);
    };
    // The API rejected our token mid-session (expired or de-whitelisted): drop
    // the wallet session so the UI returns to the signed-out gate.
    const onUnauthorized = (): void => {
      setAuthed(false);
      if (wallet) disconnect(wallet);
    };
    window.addEventListener('push-admin-login-start', onLoginStart);
    window.addEventListener('push-admin-not-authorized', onNotAuthorized);
    window.addEventListener('push-admin-authorized', onAuthorized);
    window.addEventListener('push-admin-unauthorized', onUnauthorized);
    return () => {
      window.removeEventListener('push-admin-login-start', onLoginStart);
      window.removeEventListener('push-admin-not-authorized', onNotAuthorized);
      window.removeEventListener('push-admin-authorized', onAuthorized);
      window.removeEventListener('push-admin-unauthorized', onUnauthorized);
    };
  }, [wallet, disconnect]);

  // A disconnected wallet can't be authed. We deliberately keep `notAuthorized`
  // set here so the bootstrap banner survives the disconnect above; it's cleared
  // when the next sign-in attempt starts (push-admin-login-start) or succeeds.
  useEffect(() => {
    if (!account || !wallet) setAuthed(false);
  }, [account, wallet]);

  const connect = (
    <ConnectButton
      client={client}
      wallets={wallets}
      auth={authConfig}
      connectButton={{ label: 'Sign in' }}
    />
  );

  return (
    <div style={{ fontFamily: 'system-ui, sans-serif', maxWidth: 920, margin: '0 auto', padding: 24 }}>
      <header style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 24 }}>
        <nav style={{ display: 'flex', gap: 16 }}>
          <Link to="/">Apps</Link>
          <Link to="/admins">Admins</Link>
        </nav>
        {connect}
      </header>

      {authed && account && wallet ? (
        <Routes>
          <Route path="/" element={<Apps />} />
          <Route path="/apps/:appId" element={<AppDetail />} />
          <Route path="/admins" element={<Admins />} />
        </Routes>
      ) : notAuthorized ? (
        <NotAuthorized address={notAuthorized} />
      ) : (
        <p>
          Sign in with your wallet to manage the push service. If your wallet is
          not yet authorized, you&apos;ll see the exact address to add as an admin.
        </p>
      )}
    </div>
  );
}
