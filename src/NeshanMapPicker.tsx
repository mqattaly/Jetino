import { useEffect, useRef, useState } from 'react';
import neshanMaplibre from '@neshan-maps-platform/maplibre-sdk';
import '@neshan-maps-platform/maplibre-sdk/style.css';

const apiKey = import.meta.env.VITE_NESHAN_API_KEY;
const initialCenter: [number, number] = [55.585, 26.952]; // Bandar Khamir

type Coordinates={latitude:number;longitude:number};

export default function NeshanMapPicker({value,onChange}:{value:Coordinates|null;onChange:(coordinates:Coordinates)=>void}){
 const container=useRef<HTMLDivElement>(null);
 const map=useRef<InstanceType<typeof neshanMaplibre.Map>|null>(null);
 const marker=useRef<InstanceType<typeof neshanMaplibre.Marker>|null>(null);
 const latestChange=useRef(onChange);
 const [error,setError]=useState('');
 useEffect(()=>{latestChange.current=onChange;},[onChange]);
 useEffect(()=>{
  if(!apiKey||!container.current)return;
  let instance:InstanceType<typeof neshanMaplibre.Map>;
  try{
   instance=new neshanMaplibre.Map({container:container.current,style:'https://static.neshan.org/sdk/maplibre/styles/light.json',center:value?[value.longitude,value.latitude]:initialCenter,zoom:value?16:13,apiKey});
   const pin=new neshanMaplibre.Marker({draggable:true});
   map.current=instance;marker.current=pin;
   const setPin=(longitude:number,latitude:number)=>{pin.setLngLat([longitude,latitude]).addTo(instance);};
   instance.on('load',()=>{if(value)setPin(value.longitude,value.latitude);});
   instance.on('click',(event)=>{setPin(event.lngLat.lng,event.lngLat.lat);latestChange.current({latitude:event.lngLat.lat,longitude:event.lngLat.lng});});
   pin.on('dragend',()=>{const point=pin.getLngLat();latestChange.current({latitude:point.lat,longitude:point.lng});});
   instance.on('error',()=>setError('بارگذاری نقشه نشان با خطا روبه‌رو شد؛ می‌توانید مختصات را دستی وارد کنید.'));
  }catch{
   setError('این دستگاه امکان نمایش نقشه را ندارد؛ می‌توانید مختصات را دستی وارد کنید.');
  }
  return()=>{marker.current?.remove();map.current?.remove();marker.current=null;map.current=null;};
 },[]);
 useEffect(()=>{if(!value||!map.current||!marker.current)return;marker.current.setLngLat([value.longitude,value.latitude]).addTo(map.current);map.current.easeTo({center:[value.longitude,value.latitude],zoom:16});},[value?.latitude,value?.longitude]);
 if(!apiKey)return <div className="map-unavailable">برای نمایش نقشهٔ نشان، کلید عمومی را در <code>VITE_NESHAN_API_KEY</code> تنظیم کنید. ورود مختصات دستی همچنان در دسترس است.</div>;
 return <div className="neshan-picker-wrap"><div className="neshan-map" ref={container} role="application" aria-label="انتخاب موقعیت روی نقشهٔ نشان"/><p className="map-picker-hint">روی نقشه بزنید یا نشانگر را جابه‌جا کنید تا محل تحویل تنظیم شود.</p>{error&&<p className="map-picker-error" role="status">{error}</p>}</div>;
}
