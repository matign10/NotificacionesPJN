-- Tabla para los eventos/entradas del Portal PJN
-- (api.pjn.gov.ar/eventos/), separada de notificaciones porque tienen
-- otro shape: vienen del SCW, no llevan PDF descargable directo y la PK
-- es el id del evento.

create table if not exists public.entradas_api (
  entrada_id bigint primary key,
  expediente_caratula text not null,
  expediente_clave text not null,
  fecha_accion timestamptz not null,
  fecha_creacion timestamptz not null,
  tipo text not null,
  categoria text not null,
  link_url text,
  has_document boolean not null default false,
  enviada boolean not null default false,
  fecha_envio timestamptz,
  raw jsonb not null,
  created_at timestamptz not null default now()
);

create index if not exists entradas_api_pendientes_idx
  on public.entradas_api (enviada, fecha_accion);
