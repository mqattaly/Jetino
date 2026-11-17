import React from 'react';
import { createRoot } from 'react-dom/client';
import App from './App';
import AdminApp from './AdminApp';
import { BusinessOrdersApp, CustomerOrdersApp } from './OperationsApp';
import './style.css';

const path = window.location.pathname;
const Root = path.startsWith('/admin') ? AdminApp : path.startsWith('/business') ? BusinessOrdersApp : path.startsWith('/orders') ? CustomerOrdersApp : App;
createRoot(document.getElementById('root')!).render(<React.StrictMode><Root /></React.StrictMode>);
