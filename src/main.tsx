import { StrictMode, useMemo } from 'react';
import { createRoot } from 'react-dom/client';
import { ConnectionProvider, WalletProvider } from '@solana/wallet-adapter-react';
import { WalletModalProvider } from '@solana/wallet-adapter-react-ui';
import '@solana/wallet-adapter-react-ui/styles.css';
import './styles.css';
import { AuthProvider } from './auth';
import App from './App';

// Login only needs the wallet to sign a message, so no RPC calls are made yet.
// Phantom, Solflare, Backpack and other Wallet Standard wallets are detected automatically.
const RPC = import.meta.env.VITE_SOLANA_RPC || 'https://api.mainnet-beta.solana.com';

function Root() {
  const wallets = useMemo(() => [], []);
  return (
    <ConnectionProvider endpoint={RPC}>
      <WalletProvider wallets={wallets} autoConnect={false}>
        <WalletModalProvider>
          <AuthProvider>
            <App />
          </AuthProvider>
        </WalletModalProvider>
      </WalletProvider>
    </ConnectionProvider>
  );
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <Root />
  </StrictMode>,
);
