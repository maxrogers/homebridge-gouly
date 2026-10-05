import type { API } from 'homebridge';
import { GoulyPlatform } from './platform';
import { PLATFORM_NAME } from './settings';

export = (api: API) => {
  api.registerPlatform(PLATFORM_NAME, GoulyPlatform);
};
