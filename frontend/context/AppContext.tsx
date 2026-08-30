import React, { createContext, useContext } from 'react';
import { useAuth } from './AuthContext';

interface AppContextValue {
  companyConfig: any;
  notify: (message: string, type?: 'info' | 'success' | 'warning' | 'error') => void;
  isOnline: boolean;
  user: any;
}

const AppContext = createContext<AppContextValue | undefined>(undefined);

export const AppProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  // No useAuth() call here — values are read by consumers directly from AuthContext.
  // AppContext carries its own value so existing useApp() callers keep working.
  return (
    <AppContext.Provider value={undefined}>
      {children}
    </AppContext.Provider>
  );
};

/**
 * useApp() re-exposes a subset of AuthContext values.
 * Calling useAuth() here (inside a component body) is safe because
 * the hook runs in the consumer component, which is always a descendant
 * of AuthProvider.
 */
export const useApp = (): AppContextValue => {
  const auth = useAuth();
  return {
    companyConfig: auth.companyConfig,
    notify: (message, type = 'info') => auth.notify(message, type),
    isOnline: auth.isOnline,
    user: auth.user,
  };
};

export default AppContext;
