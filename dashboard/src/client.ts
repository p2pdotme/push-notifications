import { createThirdwebClient } from 'thirdweb';

export const client = createThirdwebClient({
  clientId: import.meta.env.VITE_THIRDWEB_CLIENT_ID as string,
});

export const API_BASE_URL = import.meta.env.VITE_API_BASE_URL as string;
