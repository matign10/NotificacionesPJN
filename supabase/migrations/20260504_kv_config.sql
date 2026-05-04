-- Tabla key/value para configuración persistente.
-- Uso principal: refresh_token de Keycloak, que rota en cada uso y tiene
-- TTL de 30 min — necesitamos que sobreviva entre procesos.

create table if not exists public.kv_config (
  key text primary key,
  value text not null,
  updated_at timestamptz not null default now()
);
