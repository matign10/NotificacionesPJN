-- Hardening de seguridad: habilitar RLS en todas las tablas backend.
-- El monitor corre con SUPABASE_SERVICE_ROLE_KEY, que bypassea RLS por
-- diseño. No hace falta crear policies: sin policies, anon/authenticated
-- quedan automaticamente bloqueados. Resuelve los 3 warnings del
-- Supabase Security Advisor sobre estas tablas.

alter table public.notificaciones_api enable row level security;
alter table public.kv_config         enable row level security;
alter table public.entradas_api      enable row level security;
