import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import PartnerJoinApp from './PartnerJoinApp';
import AdminApp from './AdminApp';
import { BusinessOrdersApp, CustomerOrdersApp } from './OperationsApp';
import DriverApp from './DriverApp';
import NotificationApp from './NotificationApp';
import DesignGallery from './DesignGallery';
import { ThemeDock, ThemeProvider } from './ui/theme';
import BusinessMenuApp from './BusinessMenuApp';
import '@fontsource-variable/vazirmatn';
import './tokens.css';
import './style.css';
import './theme.css';
import './next.css';

const path = window.location.pathname;
const Root = path.startsWith('/design') ? DesignGallery : path.startsWith('/join/business') ? () => <PartnerJoinApp kind="business"/> : path.startsWith('/join/driver') ? () => <PartnerJoinApp kind="driver"/> : path.startsWith('/admin') ? AdminApp : path.startsWith('/business/menu') ? BusinessMenuApp : path.startsWith('/business') ? BusinessOrdersApp : path.startsWith('/driver') ? DriverApp : path.startsWith('/notifications') ? NotificationApp : path.startsWith('/orders') ? CustomerOrdersApp : App;
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <ThemeProvider>
      <Root />
      <ThemeDock />
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
