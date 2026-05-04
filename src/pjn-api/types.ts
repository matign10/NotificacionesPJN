export type Bandeja = 'RECIBIDAS' | 'ENVIADAS' | 'PENDIENTES';

export interface Expediente {
  id: number;
  camara: string;
  numero: number;
  anio: number;
  caratula: string;
  numeracion: string;
  situacion: string;
  oficina: string;
  reservado: number;
}

export interface Destinatario {
  id: number;
  tipo: string;
  tipoDescripcion: string;
  nombre: string;
  cuit: string;
}

export interface Oficina {
  id: number;
  idCamara: number;
  descripcion: string;
}

export interface Notificacion {
  id: number;
  expediente: Expediente;
  destinatarios: Destinatario[];
  nombreAutor: string;
  oficina: Oficina;
  fecha: string;
  numeroCedula: number;
  origen: string;
}

export interface NotificacionesPage {
  items: Notificacion[];
  hasNext: boolean;
  numberOfItems: number;
  pageSize: number;
  page: number;
}

export interface ListNotificacionesParams {
  bandeja?: Bandeja;
  fechaDesde: Date;
  fechaHasta: Date;
  page?: number;
  pageSize?: number;
}

export interface KeycloakTokenResponse {
  access_token: string;
  expires_in: number;
  refresh_expires_in: number;
  refresh_token: string;
  token_type: string;
  'not-before-policy': number;
  session_state: string;
  scope: string;
}
