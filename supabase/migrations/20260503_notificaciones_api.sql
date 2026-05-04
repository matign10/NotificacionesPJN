-- Tabla para el modo API (reemplazo del scraper).
-- Clave primaria: el id estable que devuelve el API del PJN.

create table if not exists public.notificaciones_api (
  notificacion_id bigint primary key,
  expediente_numeracion text not null,
  expediente_caratula text not null,
  fecha timestamptz not null,
  numero_cedula bigint,
  origen text,
  enviada boolean not null default false,
  fecha_envio timestamptz,
  raw jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists notificaciones_api_pendientes_idx
  on public.notificaciones_api (enviada) where enviada = false;

create index if not exists notificaciones_api_fecha_idx
  on public.notificaciones_api (fecha desc);
