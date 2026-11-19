import {
  validateBusqueda,
  validateHallazgo,
  validateHallazgoImages,
  validateHallazgoUpdate,
  validateHallazgoStateChange,
  validateImagenRef,
} from '../validation/hallazgos.js';
import validator from 'validator';

export class HallazgoError extends Error {
  constructor(status, message, errors) { super(message); this.status = status; this.errors = errors; }
}

const active = (items) => (items ?? []).filter(item => item.activo === true);
const publicItem = (item) => ({ id: item.id, nombre: item.nombre });

// Ubicación permitida (US-009-AC-03): coordenadas redondeadas a 3 decimales (unos 100 m),
// suficiente para orientarse sin exponer el punto exacto.
const aproximar = (value) => Math.round(value * 1000) / 1000;

/** Lista blanca de campos públicos (US-009-AC-04): aunque el repositorio devolviera más
 * columnas, nunca salen rasgos privados, autor ni correo. */
function publicHallazgo(row) {
  return {
    id: row.id,
    categoria: { id: row.categoria_id, nombre: row.categoria_nombre },
    facultad: { id: row.facultad_id, nombre: row.facultad_nombre },
    descripcion: row.descripcion,
    fechaHallazgo: row.fecha_hallazgo,
    ubicacion: { latitud: aproximar(row.latitud), longitud: aproximar(row.longitud), puntoEntrega: row.punto_entrega ?? null },
    estado: row.estado,
    publicadoEn: row.publicado_en,
    imagenes: (row.imagenes ?? []).map(posicion => `/api/hallazgos/${row.id}/imagenes/${posicion}`),
  };
}


/** SCRUM-49 / SCRUM-103. Cualquier usuario autenticado y activo publica hallazgos.
 * El almacenamiento (SCRUM-105) está en repositories/hallazgos.js. */
export function createHallazgoService(storage) {
  async function context(userId) {
    const result = await storage.getPublicationContext(userId);
    if (!result) throw new HallazgoError(403, 'Tu cuenta no puede publicar hallazgos.');
    return result;
  }
  return {
    /** SCRUM-113 / US-010. Solo hallazgos propios; la miniatura usa la ruta privada de fotos propias. */
    async listOwn(userId) {
      const rows = await storage.listOwnHallazgos(userId);
      return {
        hallazgos: rows.map(row => ({
          id: row.id, descripcion: row.descripcion, fechaHallazgo: row.fechaHallazgo, estado: row.estado,
          categoria: row.categoria, facultad: row.facultad, publicadoEn: row.publicadoEn,
          imagen: row.imagenId ? `/api/hallazgos/${row.id}/imagenes/${row.imagenId}` : null,
        })),
      };
    },
    async getOwn(userId, hallazgoId) {
      if (typeof hallazgoId !== 'string' || !validator.isUUID(hallazgoId)) {
        throw new HallazgoError(400, 'El identificador del hallazgo no es válido.');
      }

      const hallazgo = await storage.getOwnHallazgo(userId, hallazgoId);

      if (!hallazgo) {
        // El mismo mensaje para un hallazgo inexistente y uno ajeno.
        // Así evitamos revelar información sobre otros usuarios.
        throw new HallazgoError(404, 'Hallazgo no encontrado.');
      }

      return { hallazgo };
    },
    async getOwnImage(userId, hallazgoId, imagenId) {
      if (
        typeof hallazgoId !== 'string' ||
        !validator.isUUID(hallazgoId) ||
        typeof imagenId !== 'string' ||
        !validator.isUUID(imagenId)
      ) {
        throw new HallazgoError(400, 'El identificador no es válido.');
      }

      const imagen = await storage.getOwnHallazgoImage(
        userId,
        hallazgoId,
        imagenId,
      );

      if (!imagen) {
        // No revelar si la imagen existe pero pertenece a otro usuario.
        throw new HallazgoError(404, 'Imagen no encontrada.');
      }

      return imagen;
    },
    async getOwnHistory(userId, hallazgoId) {
      if (typeof hallazgoId !== 'string' || !validator.isUUID(hallazgoId)) {
        throw new HallazgoError(400, 'El identificador del hallazgo no es válido.');
      }

      const historial = await storage.getOwnHallazgoHistory(userId, hallazgoId);

      if (historial === null) {
        throw new HallazgoError(404, 'Hallazgo no encontrado.');
      }

      return {
        historial,
      };
    },
    async updateOwn(userId, hallazgoId, data) {
      if (typeof hallazgoId !== 'string' || !validator.isUUID(hallazgoId)) {
        throw new HallazgoError(400, 'El identificador del hallazgo no es válido.');
      }

      const { errors, value } = validateHallazgoUpdate(data);

      if (Object.keys(errors).length) {
        throw new HallazgoError(400, 'Revisa los datos del hallazgo.', errors);
      }

      const updated = await storage.updateOwnHallazgo(userId, hallazgoId, value);

      return {
        message: 'Hallazgo actualizado correctamente.',
        hallazgo: {
          id: updated.id,
          estado: updated.estado,
        },
      };
    },
    async changeOwnState(userId, hallazgoId, data) {
      if (typeof hallazgoId !== 'string' || !validator.isUUID(hallazgoId)) {
        throw new HallazgoError(400, 'El identificador del hallazgo no es válido.');
      }

      const { errors, value } = validateHallazgoStateChange(data);

      if (Object.keys(errors).length) {
        throw new HallazgoError(400, 'Revisa el cambio de estado.', errors);
      }

      const updated = await storage.changeOwnHallazgoState(
        userId,
        hallazgoId,
        value.estado,
        value.motivo,
      );

      return {
        message: 'Estado del hallazgo actualizado correctamente.',
        hallazgo: {
          id: updated.id,
          estado: updated.estado,
        },
      };
    },
    async options(userId) {
      const current = await context(userId);
      return {
        facultades: active(current.facultades).map(publicItem),
        categorias: active(current.categorias).map(publicItem),
      };
    },
    /** SCRUM-107 / US-009. Listado paginado de hallazgos Activos con filtros opcionales. */
    async search(query) {
      const { errors, value } = validateBusqueda(query);
      if (Object.keys(errors).length) throw new HallazgoError(400, 'Revisa los filtros de búsqueda.', errors);
      const result = await storage.search(value);
      const total = result.total;
      const totalPaginas = Math.ceil(total / value.tamano);
      // US-009-AC-05: con resultados, una página fuera de rango es un error comprensible.
      if (total > 0 && value.pagina > totalPaginas) {
        throw new HallazgoError(404, 'La página solicitada no existe.', {
          pagina: `Hay ${totalPaginas} ${totalPaginas === 1 ? 'página' : 'páginas'} de resultados.`,
        });
      }
      const filtrando = Boolean(value.q || value.categoriaId || value.facultadId || value.fechaDesde || value.fechaHasta);
      return {
        hallazgos: result.hallazgos.map(publicHallazgo),
        paginacion: {
          pagina: total ? value.pagina : 1, tamano: value.tamano, total, totalPaginas,
          anterior: total && value.pagina > 1 ? value.pagina - 1 : null,
          siguiente: value.pagina < totalPaginas ? value.pagina + 1 : null,
          corte: result.corte,
        },
        ...(total ? {} : {
          message: filtrando ? 'No hay hallazgos activos que coincidan con la búsqueda.' : 'Todavía no hay hallazgos activos.',
        }),
      };
    },
    async image(id, posicion) {
      if (!validateImagenRef(id, posicion)) throw new HallazgoError(404, 'Imagen no encontrada.');
      const image = await storage.getImage(id, Number(posicion));
      if (!image) throw new HallazgoError(404, 'Imagen no encontrada.');
      return image;
    },
    async publish(userId, data, files) {
      const { errors, value } = validateHallazgo(data);
      if (Object.keys(errors).length) throw new HallazgoError(400, 'Revisa los datos del hallazgo.', errors);
      const current = await context(userId);
      if (!active(current.facultades).some(item => item.id === value.facultadId)) {
        throw new HallazgoError(400, 'Selecciona una facultad activa.', { facultadId: 'La facultad no existe o está inactiva.' });
      }
      if (!active(current.categorias).some(item => item.id === value.categoriaId)) {
        throw new HallazgoError(400, 'Selecciona una categoría activa.', { categoriaId: 'La categoría no existe o está inactiva.' });
      }
      const validated = await validateHallazgoImages(files);
      if (validated.error) throw new HallazgoError(400, 'Revisa las imágenes.', { imagenes: validated.error });
      // SCRUM-105: el repositorio guarda el hallazgo de forma atómica en una transacción, separa los rasgos
      // privados y vuelve a comprobar cuenta, facultad y categoría antes de guardar.
      const created = await storage.publish({
        ...value, autorId: userId, estado: 'Activo', imagenes: validated.images,
      });
      if (!created || typeof created.id !== 'string' || !created.id) throw new Error('Respuesta de almacenamiento inválida.');
      // Nunca devolver el objeto entero del repositorio: podría incluir rasgos privados.
      return { message: 'Hallazgo publicado correctamente.', hallazgo: { id: created.id, estado: 'Activo' } };
    },
  };
}
