import { useActiveAccount } from 'thirdweb/react';
import { ConnectButton, useActiveWallet } from 'thirdweb/react';
import { inAppWallet } from 'thirdweb/wallets';
import { Link, Route, Routes } from 'react-router-dom';
import { client } from './client.js';
import { authConfig } from './auth.js';
import { Apps } from './pages/Apps.js';
import { AppDetail } from './pages/AppDetail.js';
import { Admins } from './pages/Admins.js';

const wallets = [inAppWallet({ auth: { options: ['google', 'email'] } })];

export function App() {
  const account = useActiveAccount();
  const wallet = useActiveWallet();

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

      {!account || !wallet ? (
        <p>Sign in with your wallet to manage the push service. If your wallet
          is not yet authorized, the sign-in error will show your address — add it
          to <code>ADMIN_WALLETS</code> and restart the server.</p>
      ) : (
        <Routes>
          <Route path="/" element={<Apps />} />
          <Route path="/apps/:appId" element={<AppDetail />} />
          <Route path="/admins" element={<Admins />} />
        </Routes>
      )}
    </div>
  );
}
