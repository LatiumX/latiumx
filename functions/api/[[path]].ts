import { handle } from '../../server/routes';
import type { Env } from '../../server/env';

export const onRequest: PagesFunction<Env> = ({ request, env }) => handle(request, env);
