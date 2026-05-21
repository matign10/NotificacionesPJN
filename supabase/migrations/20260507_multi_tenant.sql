-- Multi-tenant: varios usuarios PJN sobre la misma base, cada uno con su
-- propio bot de Telegram. Se agrega user_id como discriminador y se
-- recompone la PK como (user_id, id_del_PJN). El default 'matias' preserva
-- los datos existentes del unico usuario actual.

alter table public.notificaciones_api
  add column if not exists user_id text not null default 'matias';
alter table public.entradas_api
  add column if not exists user_id text not null default 'matias';

-- Recomponer las PK como compuestas. El id del PJN deja de ser unico
-- global y pasa a ser unico por usuario.
alter table public.notificaciones_api drop constraint if exists notificaciones_api_pkey;
alter table public.notificaciones_api add primary key (user_id, notificacion_id);

alter table public.entradas_api drop constraint if exists entradas_api_pkey;
alter table public.entradas_api add primary key (user_id, entrada_id);

-- Indices para las queries de pendientes filtradas por usuario.
create index if not exists notificaciones_api_user_pendientes_idx
  on public.notificaciones_api (user_id, enviada) where enviada = false;
create index if not exists entradas_api_user_pendientes_idx
  on public.entradas_api (user_id, enviada) where enviada = false;

-- Namespacear los refresh_tokens del usuario actual al nuevo esquema.
-- Los usuarios nuevos guardan directamente con sufijo _<id>.
update public.kv_config set key = 'pjn_refresh_token_sne_matias'
  where key = 'pjn_refresh_token_sne';
update public.kv_config set key = 'pjn_refresh_token_portal_matias'
  where key = 'pjn_refresh_token_portal';
