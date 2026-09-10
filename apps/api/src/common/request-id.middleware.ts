import { Injectable, type NestMiddleware } from '@nestjs/common';
import type { NextFunction, Request, Response } from 'express';
import { randomString } from '@colibripay/shared';

/**
 * Asigna un ID a cada petición y lo devuelve en la cabecera.
 *
 * Cuando un comercio abre un ticket diciendo "un cobro falló", este ID es lo
 * que convierte una búsqueda a ciegas en una consulta directa.
 */
@Injectable()
export class RequestIdMiddleware implements NestMiddleware {
  use(req: Request, res: Response, next: NextFunction): void {
    const requestId = `req_${randomString(20)}`;
    req.requestId = requestId;
    res.setHeader('colibri-request-id', requestId);
    next();
  }
}
