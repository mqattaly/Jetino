import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AdminApp from './AdminApp';
import { BusinessOrdersApp, CustomerOrdersApp } from './OperationsApp';
import DriverApp from './DriverApp';
import NotificationApp from './NotificationApp';
import BusinessMenuApp from './BusinessMenuApp';
import '@fontsource-variable/vazirmatn';
import './tokens.css';
import './style.css';
import './theme.css';

const path = window.location.pathname;
const Root = path.startsWith('/admin') ? AdminApp : path.startsWith('/business/menu') ? BusinessMenuApp : path.startsWith('/business') ? BusinessOrdersApp : path.startsWith('/driver') ? DriverApp : path.startsWith('/notifications') ? NotificationApp : path.startsWith('/orders') ? CustomerOrdersApp : App;
createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>);

if ('serviceWorker' in navigator && import.meta.env.PROD) {
  window.addEventListener('load', () => {
    void navigator.serviceWorker.register('/sw.js').catch((error: unknown) => {
      console.warn('ثبت نسخهٔ وب‌اپ جتینو ناموفق بود.', error);
    });
  });
}
