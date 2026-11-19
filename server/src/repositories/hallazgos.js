import { randomUUID } from 'node:crypto';
import { HallazgoError } from '../services/hallazgos.js';

/** SCRUM-105. Almacenamiento de hallazgos, rasgos privados y fotos en PostgreSQL.
 * Cualquier cuenta activa puede publicar (SCRUM-103); la tabla asignaciones_conserje
 * queda preparada para cuando la publicación se reserve a Conserjería (US-025). */
export function createHallazgoRepository(pool) {
  if (!pool) {
    // Sin base de datos (p. ej. pruebas que no la configuran): respuesta explícita, nunca éxito simulado.
    const unavailable = async () => {
      throw new HallazgoError(503, 'La publicación de hallazgos no está disponible en este momento.');
    };
    const searchUnavailable = async () => {
      throw new HallazgoError(503, 'La búsqueda de hallazgos no está disponible en este momento.');
    };
    return {
      getPublicationContext: unavailable,
      publish: unavailable,
      listOwnHallazgos: unavailable,
      getOwnHallazgo: unavailable,
      updateOwnHallazgo: unavailable,
      changeOwnHallazgoState: unavailable,
      getOwnHallazgoHistory: unavailable,
      getOwnHallazgoImage: unavailable,
      search: searchUnavailable,
      getImage: searchUnavailable,
    };
  }

  return {
    /** SCRUM-113 / US-010. Hallazgos del autor en cualquier estado, del más reciente al más antiguo. */
    async listOwnHallazgos(userId) {
      const { rows } = await pool.query(
        `SELECT h.id, h.descripcion, to_char(h.fecha_hallazgo, 'YYYY-MM-DD') AS "fechaHallazgo", h.estado,
                c.nombre AS "categoria", f.nombre AS "facultad", h.created_at AS "publicadoEn",
                (SELECT i.id FROM hallazgo_imagenes i WHERE i.hallazgo_id = h.id ORDER BY i.posicion LIMIT 1) AS "imagenId"
           FROM hallazgos h
           JOIN categorias c ON c.id = h.categoria_id
           JOIN facultades f ON f.id = h.facultad_id
          WHERE h.autor_id = $1
          ORDER BY h.created_at DESC, h.id DESC
          LIMIT 200`,
        [userId],
      );
      return rows;
    },
    async getOwnHallazgo(userId, hallazgoId) {
      // Los dos identificadores se comprueban en PostgreSQL.
      // El filtro de autor impide consultar hallazgos ajenos.
      const { rows } = await pool.query(
        `SELECT h.id, h.autor_id AS "autorId",
                h.facultad_id AS "facultadId",
                h.categoria_id AS "categoriaId",
                h.descripcion,
                to_char(h.fecha_hallazgo, 'YYYY-MM-DD') AS "fechaHallazgo",
                h.latitud, h.longitud,
                h.punto_entrega AS "puntoEntrega",
                h.estado,
                h.created_at AS "createdAt",
                h.updated_at AS "updatedAt",
                rp.rasgos AS "rasgosPrivados"
        FROM hallazgos h
        LEFT JOIN hallazgo_rasgos_privados rp ON rp.hallazgo_id = h.id
        WHERE h.id = $1 AND h.autor_id = $2`,
        [hallazgoId, userId],
      );

      const hallazgo = rows[0];
      if (!hallazgo) return null;

      const { rows: imagenes } = await pool.query(
        `SELECT id, posicion, mime
        FROM hallazgo_imagenes
        WHERE hallazgo_id = $1
        ORDER BY posicion`,
        [hallazgoId],
      );

      return {
        ...hallazgo,
        imagenes,
      };
    },
    async getOwnHallazgoImage(userId, hallazgoId, imagenId) {
      const { rows } = await pool.query(
        `SELECT i.mime, i.datos
        FROM hallazgo_imagenes i
        INNER JOIN hallazgos h ON h.id = i.hallazgo_id
        WHERE h.id = $1
          AND h.autor_id = $2
          AND i.id = $3`,
        [hallazgoId, userId, imagenId],
      );

      return rows[0] ?? null;
    },
    async getOwnHallazgoHistory(userId, hallazgoId) {
      // Comprobar primero que el hallazgo pertenece al usuario.
      const { rowCount } = await pool.query(
        `SELECT 1
        FROM hallazgos
        WHERE id = $1 AND autor_id = $2`,
        [hallazgoId, userId],
      );

      if (!rowCount) return null;

      const { rows } = await pool.query(
        `SELECT id,
                usuario_id AS "usuarioId",
                estado_anterior AS "estadoAnterior",
                estado_nuevo AS "estadoNuevo",
                motivo,
                created_at AS "fecha"
        FROM hallazgo_historial_estados
        WHERE hallazgo_id = $1
        ORDER BY created_at ASC, id ASC`,
        [hallazgoId],
      );

      return rows;
    },
    async updateOwnHallazgo(userId, hallazgoId, changes) {
      const columns = {
        facultadId: 'facultad_id',
        categoriaId: 'categoria_id',
        descripcion: 'descripcion',
        fechaHallazgo: 'fecha_hallazgo',
        latitud: 'latitud',
        longitud: 'longitud',
        puntoEntrega: 'punto_entrega',
      };

      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        // Bloquear el hallazgo para evitar modificaciones simultáneas.
        const { rows } = await client.query(
          `SELECT estado
          FROM hallazgos
          WHERE id = $1 AND autor_id = $2
          FOR UPDATE`,
          [hallazgoId, userId],
        );

        if (!rows.length) {
          throw new HallazgoError(404, 'Hallazgo no encontrado.');
        }

        if (rows[0].estado !== 'Activo') {
          throw new HallazgoError(409, 'Solo se pueden editar hallazgos activos.');
        }

        // Comprobar que las nuevas referencias estén activas.
        for (const [field, table] of [
          ['facultadId', 'facultades'],
          ['categoriaId', 'categorias'],
        ]) {
          if (!(field in changes)) continue;

          const { rowCount } = await client.query(
            `SELECT 1 FROM ${table} WHERE id = $1 AND activo FOR SHARE`,
            [changes[field]],
          );

          if (!rowCount) {
            throw new HallazgoError(400, 'Revisa los datos del hallazgo.', {
              [field]: 'La opción no existe o está inactiva.',
            });
          }
        }

        const fields = Object.keys(changes)
          .filter(field => field in columns);

        if (fields.length) {
          const assignments = fields.map(
            (field, index) => `${columns[field]} = $${index + 3}`,
          );

          await client.query(
            `UPDATE hallazgos
            SET ${assignments.join(', ')},
                updated_at = CURRENT_TIMESTAMP
            WHERE id = $1 AND autor_id = $2`,
            [hallazgoId, userId, ...fields.map(field =>
              field === 'puntoEntrega' ? changes[field] || null : changes[field]
            )],
          );
        }

        // Los rasgos privados se almacenan en una tabla separada.
        if ('rasgosPrivados' in changes) {
          if (changes.rasgosPrivados) {
            await client.query(
              `INSERT INTO hallazgo_rasgos_privados (hallazgo_id, rasgos)
              VALUES ($1, $2)
              ON CONFLICT (hallazgo_id)
              DO UPDATE SET rasgos = EXCLUDED.rasgos`,
              [hallazgoId, changes.rasgosPrivados],
            );
          } else {
            await client.query(
              'DELETE FROM hallazgo_rasgos_privados WHERE hallazgo_id = $1',
              [hallazgoId],
            );
          }

          if (!fields.length) {
            await client.query(
              'UPDATE hallazgos SET updated_at = CURRENT_TIMESTAMP WHERE id = $1',
              [hallazgoId],
            );
          }
        }

        await client.query('COMMIT');
        return { id: hallazgoId, estado: 'Activo' };

      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    async changeOwnHallazgoState(userId, hallazgoId, nuevoEstado, motivo) {
      const client = await pool.connect();

      try {
        await client.query('BEGIN');

        const { rows } = await client.query(
          `SELECT estado
          FROM hallazgos
          WHERE id = $1 AND autor_id = $2
          FOR UPDATE`,
          [hallazgoId, userId],
        );

        if (!rows.length) {
          throw new HallazgoError(404, 'Hallazgo no encontrado.');
        }

        const estadoAnterior = rows[0].estado;

        if (estadoAnterior !== 'Activo') {
          throw new HallazgoError(
            409,
            'Un hallazgo Devuelto o Retirado no puede cambiar de estado.',
          );
        }

        if (!['Devuelto', 'Retirado'].includes(nuevoEstado)) {
          throw new HallazgoError(400, 'Cambio de estado no permitido.');
        }

        await client.query(
          `UPDATE hallazgos
          SET estado = $1, updated_at = CURRENT_TIMESTAMP
          WHERE id = $2 AND autor_id = $3`,
          [nuevoEstado, hallazgoId, userId],
        );

        await client.query(
          `INSERT INTO hallazgo_historial_estados
          (id, hallazgo_id, usuario_id, estado_anterior, estado_nuevo, motivo)
          VALUES ($1, $2, $3, $4, $5, $6)`,
          [
            randomUUID(),
            hallazgoId,
            userId,
            estadoAnterior,
            nuevoEstado,
            motivo || null,
          ],
        );

        await client.query('COMMIT');

        return { id: hallazgoId, estado: nuevoEstado };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
    /** SCRUM-107 / US-009. Solo hallazgos Activos y solo columnas públicas: nunca rasgos privados ni datos del autor.
     * Orden estable (más recientes primero, id como desempate) y `corte` fijo: al paginar no se duplican ni se pierden resultados. */
    async search({ terminos, categoriaId, facultadId, fechaDesde, fechaHasta, pagina, tamano, corte }) {
      const client = await pool.connect();
      try {
        // Ambas consultas ven la misma instantánea de la base de datos.
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const instante = corte || (await client.query("SELECT to_json(clock_timestamp()) #>> '{}' AS corte")).rows[0].corte;
        const params = [instante];
        const where = ["h.estado = 'Activo'", 'h.created_at <= $1::timestamptz'];
        const add = (sql, value) => { params.push(value); where.push(sql.replace('?', `$${params.length}`)); };
        // Cada palabra debe aparecer en la descripción pública; % y _ se buscan como texto literal.
        for (const termino of terminos) add('h.descripcion ILIKE ?', `%${termino.replace(/[\\%_]/g, String.raw`\$&`)}%`);
        if (categoriaId) add('h.categoria_id = ?::uuid', categoriaId);
        if (facultadId) add('h.facultad_id = ?::uuid', facultadId);
        if (fechaDesde) add('h.fecha_hallazgo >= ?::date', fechaDesde);
        if (fechaHasta) add('h.fecha_hallazgo <= ?::date', fechaHasta);
        const filtro = where.join(' AND ');

        const { rows: [{ total }] } = await client.query(`SELECT count(*)::int AS total FROM hallazgos h WHERE ${filtro}`, params);
        const { rows } = await client.query(
          `SELECT h.id, h.descripcion, to_char(h.fecha_hallazgo, 'YYYY-MM-DD') AS fecha_hallazgo,
                  h.latitud, h.longitud, h.punto_entrega, h.estado, to_json(h.created_at) #>> '{}' AS publicado_en,
                  c.id AS categoria_id, c.nombre AS categoria_nombre, f.id AS facultad_id, f.nombre AS facultad_nombre,
                  COALESCE((SELECT array_agg(i.posicion ORDER BY i.posicion) FROM hallazgo_imagenes i WHERE i.hallazgo_id = h.id), '{}') AS imagenes
             FROM hallazgos h
             JOIN categorias c ON c.id = h.categoria_id
             JOIN facultades f ON f.id = h.facultad_id
            WHERE ${filtro}
            ORDER BY h.created_at DESC, h.id DESC
            LIMIT $${params.length + 1} OFFSET $${params.length + 2}`,
          [...params, tamano, (pagina - 1) * tamano],
        );
        await client.query('COMMIT');
        return { total, corte: instante, hallazgos: rows };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },

    /** Foto pública: solo si el hallazgo sigue Activo. */
    async getImage(hallazgoId, posicion) {
      const { rows } = await pool.query(
        `SELECT i.mime, i.datos FROM hallazgo_imagenes i JOIN hallazgos h ON h.id = i.hallazgo_id
          WHERE h.id = $1 AND i.posicion = $2 AND h.estado = 'Activo'`,
        [hallazgoId, posicion],
      );
      return rows[0] ?? null;
    },

    async getPublicationContext(userId) {
      const { rowCount } = await pool.query('SELECT 1 FROM usuarios WHERE id = $1 AND activo', [userId]);
      if (!rowCount) return null;
      const { rows: facultades } = await pool.query('SELECT id, nombre, activo FROM facultades WHERE activo ORDER BY nombre');
      const { rows: categorias } = await pool.query('SELECT id, nombre, activo FROM categorias WHERE activo ORDER BY nombre');
      return { facultades, categorias };
    },

    /** Guarda TODO o NADA: hallazgo, rasgos privados y fotos en una única transacción. */
    async publish(input) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        // Volver a comprobar cuenta, facultad y categoría dentro de la transacción y
        // bloquearlas frente a cambios simultáneos hasta el COMMIT.
        const { rowCount: cuenta } = await client.query(
          'SELECT 1 FROM usuarios WHERE id = $1 AND activo FOR SHARE', [input.autorId],
        );
        if (!cuenta) throw new HallazgoError(403, 'Tu cuenta no puede publicar hallazgos.');

        const { rowCount: facultad } = await client.query(
          'SELECT 1 FROM facultades WHERE id = $1 AND activo FOR SHARE', [input.facultadId],
        );
        if (!facultad) {
          throw new HallazgoError(400, 'Selecciona una facultad activa.', { facultadId: 'La facultad no existe o está inactiva.' });
        }

        const { rowCount: categoria } = await client.query(
          'SELECT 1 FROM categorias WHERE id = $1 AND activo FOR SHARE', [input.categoriaId],
        );
        if (!categoria) {
          throw new HallazgoError(400, 'Selecciona una categoría activa.', { categoriaId: 'La categoría no existe o está inactiva.' });
        }

        const id = randomUUID();
        await client.query(
          `INSERT INTO hallazgos (id, autor_id, facultad_id, categoria_id, descripcion, fecha_hallazgo,
             latitud, longitud, punto_entrega, estado)
           VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
          [id, input.autorId, input.facultadId, input.categoriaId, input.descripcion, input.fechaHallazgo,
            input.latitud, input.longitud, input.puntoEntrega || null, input.estado],
        );
        if (input.rasgosPrivados) {
          await client.query(
            'INSERT INTO hallazgo_rasgos_privados (hallazgo_id, rasgos) VALUES ($1, $2)',
            [id, input.rasgosPrivados],
          );
        }
        // Nombres e identificadores generados por el servidor; el nombre del archivo del cliente no se usa.
        for (const [index, image] of input.imagenes.entries()) {
          await client.query(
            'INSERT INTO hallazgo_imagenes (id, hallazgo_id, posicion, mime, datos) VALUES ($1, $2, $3, $4, $5)',
            [randomUUID(), id, index + 1, image.mime, image.buffer],
          );
        }
        await client.query('COMMIT');
        return { id };
      } catch (error) {
        await client.query('ROLLBACK').catch(() => {});
        throw error;
      } finally {
        client.release();
      }
    },
  };
}
