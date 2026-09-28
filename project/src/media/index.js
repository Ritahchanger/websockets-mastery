// Media is optional: if mediasoup can't load (no prebuilt worker for this
// platform, MEDIA_ENABLED=false in tests), chat keeps working and every
// media:* request answers `media_unavailable`.
import { WorkerPool } from './workerPool.js';
import { MediaService } from './handlers.js';
import { ClientMessages, ProtocolError } from '../ws/protocol.js';
import { logger } from '../logger.js';

export async function createMedia({ config, hub, router, validateRoom }) {
  if (config.media.enabled) {
    try {
      const mediasoup = await import('mediasoup');
      const pool = new WorkerPool(mediasoup, config.media);
      await pool.start();
      const service = new MediaService({ pool, config, hub, validateRoom });
      service.register(router);
      return { available: true, service, huddles: () => service.huddles(), stats: () => service.stats(), workerStats: () => pool.stats(), close: () => service.close() };
    } catch (err) {
      logger.warn('mediasoup unavailable, huddles disabled', { err: err.message });
    }
  }
  for (const type of Object.keys(ClientMessages).filter((t) => t.startsWith('media:'))) {
    router.on(type, () => {
      throw new ProtocolError('media_unavailable', 'Video huddles are disabled on this server');
    });
  }
  return { available: false, service: null, huddles: () => [], stats: () => ({ rooms: 0, peers: 0, producers: 0, consumers: 0, workers: 0 }), workerStats: async () => [], close: () => {} };
}
