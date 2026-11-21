import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import PartnerJoinApp from './PartnerJoinApp';
import AdminApp from './AdminApp';
import { BusinessOrdersApp, CustomerOrdersApp } from './OperationsApp';
import DriverApp from './DriverApp';
import NotificationApp from './NotificationApp';
import GroceryApp from './GroceryApp';
import GroceryStoreApp from './GroceryStoreApp';
import { ThemeProvider } from './ui/theme';
import { LiquidBackdrop, installLiquidProgress, useReveal } from './ui/motion';
import BusinessMenuApp from './BusinessMenuApp';
import '@fontsource-variable/vazirmatn';
import './tokens.css';
import './style.css';
import './theme.css';
import './next.css';
import './liquid.css';

const path = window.location.pathname;
const Root = path.startsWith('/join/business') ? () => <PartnerJoinApp kind="business"/> : path.startsWith('/join/driver') ? () => <PartnerJoinApp kind="driver"/> : path.startsWith('/admin') ? AdminApp : path.startsWith('/business/menu') ? BusinessMenuApp : path.startsWith('/business') ? BusinessOrdersApp : path.startsWith('/driver') ? DriverApp : path.startsWith('/notifications') ? NotificationApp : path.startsWith('/orders') ? CustomerOrdersApp : path.startsWith('/grocery/store') ? GroceryStoreApp : path.startsWith('/grocery') ? GroceryApp : App;
// The liquid progress bar listens to the very first request of the session, so it
// has to wrap `fetch` before any component mounts.
installLiquidProgress();

/**
 * The glass frame: ambience behind, the page above it. Every route is wrapped the
 * same way, so the moving light never depends on what a screen renders.
 */
function Frame() {
  useReveal();
  return <>
    <LiquidBackdrop />
    <div className="app-frame"><Root /></div>
  </>;
}

createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <Frame />
    </ThemeProvider>
  </React.StrictMode>,
);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.warn('ثبت نسخهٔ وب‌اپ جتینو ناموفق بود.', error);
    });
  });
}
