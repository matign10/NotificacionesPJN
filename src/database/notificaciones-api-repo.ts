import { createClient, SupabaseClient } from '@supabase/supabase-js';
import { logger } from '../config';
import { Entrada, Notificacion } from '../pjn-api/types';

export interface EntradaApiRow {
  user_id: string;
  entrada_id: number;
  expediente_caratula: string;
  expediente_clave: string;
  fecha_accion: string;
  fecha_creacion: string;
  tipo: string;
  categoria: string;
  link_url: string | null;
  has_document: boolean;
  enviada: boolean;
  fecha_envio: string | null;
  raw: Entrada;
  created_at: string;
}

export interface NotificacionApiRow {
  user_id: string;
  notificacion_id: number;
  expediente_numeracion: string;
  expediente_caratula: string;
  fecha: string;
  numero_cedula: number | null;
  origen: string | null;
  enviada: boolean;
  fecha_envio: string | null;
  raw: Notificacion;
  created_at: string;
}

const TABLE = 'notificaciones_api';
const ENTRADAS_TABLE = 'entradas_api';

export class NotificacionesApiRepo {
  private client: SupabaseClient;
  private userId: string;

  constructor(userId: string = 'matias') {
    this.userId = userId;
    const url = process.env.SUPABASE_URL;
    const key = process.env.SUPABASE_SERVICE_ROLE_KEY;
    if (!url || !key) {
      throw new Error('Faltan SUPABASE_URL y/o SUPABASE_SERVICE_ROLE_KEY en el entorno.');
    }
    this.client = createClient(url, key);
  }

  async ping(): Promise<void> {
    const { error } = await this.client.from(TABLE).select('notificacion_id').limit(1);
    if (error && error.code !== 'PGRST116') {
      throw new Error(`Supabase ping falló (${error.code}): ${error.message}`);
    }
  }

  async existsById(id: number): Promise<boolean> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('notificacion_id')
      .eq('user_id', this.userId)
      .eq('notificacion_id', id)
      .maybeSingle();
    if (error) throw error;
    return !!data;
  }

  async insertIfMissing(notif: Notificacion): Promise<boolean> {
    const row = {
      user_id: this.userId,
      notificacion_id: notif.id,
      expediente_numeracion: notif.expediente.numeracion,
      expediente_caratula: notif.expediente.caratula,
      fecha: new Date(notif.fecha).toISOString(),
      numero_cedula: notif.numeroCedula ?? null,
      origen: notif.origen ?? null,
      enviada: false,
      raw: notif,
    };
    const { error } = await this.client
      .from(TABLE)
      .insert(row);

    if (error) {
      // 23505 = unique violation: ya existía, no es error
      if (error.code === '23505') return false;
      throw error;
    }
    return true;
  }

  async markSent(id: number): Promise<void> {
    const { error } = await this.client
      .from(TABLE)
      .update({ enviada: true, fecha_envio: new Date().toISOString() })
      .eq('user_id', this.userId)
      .eq('notificacion_id', id);
    if (error) throw error;
  }

  async getPendientes(): Promise<NotificacionApiRow[]> {
    const { data, error } = await this.client
      .from(TABLE)
      .select('*')
      .eq('user_id', this.userId)
      .eq('enviada', false)
      .order('fecha', { ascending: true });
    if (error) throw error;
    return (data ?? []) as NotificacionApiRow[];
  }

  async getConfig(key: string): Promise<string | null> {
    const { data, error } = await this.client
      .from('kv_config')
      .select('value')
      .eq('key', key)
      .maybeSingle();
    if (error) throw error;
    return data?.value ?? null;
  }

  async setConfig(key: string, value: string): Promise<void> {
    const { error } = await this.client
      .from('kv_config')
      .upsert({ key, value, updated_at: new Date().toISOString() }, { onConflict: 'key' });
    if (error) throw error;
  }

  async insertEntradaIfMissing(entrada: Entrada): Promise<boolean> {
    const row = {
      user_id: this.userId,
      entrada_id: entrada.id,
      expediente_caratula: entrada.payload?.caratulaExpediente ?? '(sin carátula)',
      expediente_clave: entrada.payload?.claveExpediente ?? '',
      fecha_accion: new Date(entrada.fechaAccion).toISOString(),
      fecha_creacion: new Date(entrada.fechaCreacion).toISOString(),
      tipo: entrada.tipo,
      categoria: entrada.categoria,
      link_url: entrada.link?.url ?? null,
      has_document: !!entrada.hasDocument,
      enviada: false,
      raw: entrada,
    };
    const { error } = await this.client.from(ENTRADAS_TABLE).insert(row);
    if (error) {
      if (error.code === '23505') return false;
      throw error;
    }
    return true;
  }

  async markEntradaSent(id: number): Promise<void> {
    const { error } = await this.client
      .from(ENTRADAS_TABLE)
      .update({ enviada: true, fecha_envio: new Date().toISOString() })
      .eq('user_id', this.userId)
      .eq('entrada_id', id);
    if (error) throw error;
  }

  async getEntradasPendientes(): Promise<EntradaApiRow[]> {
    const { data, error } = await this.client
      .from(ENTRADAS_TABLE)
      .select('*')
      .eq('user_id', this.userId)
      .eq('enviada', false)
      .order('fecha_accion', { ascending: true });
    if (error) throw error;
    return (data ?? []) as EntradaApiRow[];
  }

  async getStats(): Promise<{ total: number; pendientes: number; enviadas: number }> {
    const [total, pendientes, enviadas] = await Promise.all([
      this.client.from(TABLE).select('*', { count: 'exact', head: true }).eq('user_id', this.userId),
      this.client.from(TABLE).select('*', { count: 'exact', head: true }).eq('user_id', this.userId).eq('enviada', false),
      this.client.from(TABLE).select('*', { count: 'exact', head: true }).eq('user_id', this.userId).eq('enviada', true),
    ]);
    if (total.error || pendientes.error || enviadas.error) {
      logger.warn('Error en getStats', { total: total.error, pendientes: pendientes.error, enviadas: enviadas.error });
    }
    return {
      total: total.count ?? 0,
      pendientes: pendientes.count ?? 0,
      enviadas: enviadas.count ?? 0,
    };
  }
}
