import { SegmentId } from '../models/segment';
import { MetricExpanded } from '../models/metric';
import { DatasourceRequest } from '../models/datasource';
import { SegmentsSet } from '../models/segment_set';
import { AnalyticUnitId, AnalyticUnit, AnalyticSegment } from '../models/analytic_units/analytic_unit';
import { HasticServerInfo, HasticServerInfoUnknown } from '../models/hastic_server_info';
import { DetectionSpan } from '../models/detection';
import { PanelTemplate, TemplateVariables } from '../models/panel';

import { isHasticServerResponse, isSupportedServerVersion, SUPPORTED_SERVER_VERSION } from '../../../utils';

import { appEvents } from 'grafana/app/core/core';

import * as _ from 'lodash';


declare global {
  interface Window { hasticDatasourcesAvailability: { [key: string]: HasticDatasourceAvailability } }
}

// TODO: TableTimeSeries is bad name
export type TableTimeSeries = {
  values: [number, number][];
  columns: string[];
};

export enum HasticDatasourceAvailability {
  AVAILABLE = 'success',
  NOT_AVAILABLE = 'error'
};

export type HasticDatasourceStatus = {
  testing: boolean,
  availability: HasticDatasourceAvailability,
  message: string
}

export class AnalyticService {
  public hasticDatasourceStatus: HasticDatasourceStatus = {
    testing: false,
    availability: HasticDatasourceAvailability.NOT_AVAILABLE,
    message: ''
  };

  private _isUp: boolean = false;

  constructor(
    private _hasticDatasourceURL: string,
    private $http
  ) {
    if(this._hasticDatasourceURL === undefined) {
      throw new TypeError('_hasticDatasourceURL is undefined');
    }
  }

  async getAnalyticUnitTypes() {
    const resp = await this.get('/analyticUnits/types');
    if(resp === undefined) {
      return {};
    }
    return resp;
  }

  async getAnalyticUnits(panelId: string) {
    const resp = await this.get('/analyticUnits/units', { panelId });
    if(resp === undefined) {
      return [];
    }
    return resp.analyticUnits;
  }

  async exportPanel(panelId: string): Promise<PanelTemplate> {
    const resp = await this.get('/panels/template', { panelId });
    if(resp === undefined) {
      return {};
    }
    return resp;
  }

  async importPanel(
    panelTemplate: PanelTemplate,
    templateVariables: TemplateVariables
  ): Promise<void> {
    await this.post('/panels/template', { panelTemplate, templateVariables });
  }

  async postNewAnalyticUnit(
    analyticUnit: AnalyticUnit,
    metric: MetricExpanded,
    datasource: DatasourceRequest,
    grafanaUrl: string,
    panelId: string
  ): Promise<AnalyticUnitId> {
    const analyticUnitJson = analyticUnit.toJSON();
    const response = await this.post('/analyticUnits', {
      grafanaUrl,
      panelId,
      metric: metric.toJSON(),
      datasource,
      ...analyticUnitJson
    });

    return response.id as AnalyticUnitId;
  }

  async updateMetric(
    analyticUnitId: AnalyticUnitId,
    metric: MetricExpanded,
    datasource: DatasourceRequest
  ) {
    await this.patch('/analyticUnits/metric', {
      analyticUnitId,
      metric: metric.toJSON(),
      datasource
    });
  }

  async removeAnalyticUnit(id: AnalyticUnitId) {
    return this.delete('/analyticUnits', { id });
  }

  private async _isDatasourceAvailable(): Promise<boolean> {
    if(!this._checkDatasourceConfig()) {
      return false;
    }
    try {
      const response = await this.get('/');
      if(!isHasticServerResponse(response)) {
        this.displayWrongUrlAlert();
        return false
      } else if(!isSupportedServerVersion(response)) {
        this.displayUnsupportedVersionAlert(response.packageVersion);
        return false;
      }

      const message = [
        'Connected to Hastic Datasource',
        `Hastic datasource URL: "${this._hasticDatasourceURL}"`
      ];
      this._displayConnectionAlert(HasticDatasourceAvailability.AVAILABLE, message);

      return true;
    } catch(e) {
      console.error(e);
      return false;
    }
  }

  async updateSegments(
    id: AnalyticUnitId,
    addedSegments: SegmentsSet<AnalyticSegment>,
    removedSegments: SegmentsSet<AnalyticSegment>
  ): Promise<SegmentId[]> {
    const getJSONs = (segs: SegmentsSet<AnalyticSegment>) => segs.getSegments().map(segment => ({
      from: segment.from,
      to: segment.to,
      labeled: segment.labeled,
      deleted: segment.deleted
    }));

    const payload = {
      id,
      addedSegments: getJSONs(addedSegments),
      removedSegments: removedSegments.getSegments().map(s => s.id)
    };

    const data = await this.patch('/segments', payload);
    if(data.addedIds === undefined) {
      throw new Error('Server didn`t send addedIds');
    }
    return data.addedIds as SegmentId[];
  }

  async getDetectionSpans(id: AnalyticUnitId, from: number, to: number): Promise<DetectionSpan[]> {
    if(id === undefined) {
      throw new Error('id is undefined');
    }
    let payload: any = { id, from, to };
    const data = await this.get('/detections/spans', payload);
    if(data === undefined || data.spans === undefined) {
      throw new Error('Server didn`t return spans array');
    }
    return data.spans;
  }

  async getSegments(id: AnalyticUnitId, from?: number, to?: number): Promise<AnalyticSegment[]> {
    if(id === undefined) {
      throw new Error('id is undefined');
    }
    var payload: any = { id };
    if(from !== undefined) {
      payload['from'] = from;
    }
    if(to !== undefined) {
      payload['to'] = to;
    }
    var data = await this.get('/segments', payload);
    if(data.segments === undefined) {
      throw new Error('Server didn`t return segments array');
    }
    var segments = data.segments as { id: SegmentId, from: number, to: number, labeled: boolean, deleted: boolean }[];
    return segments.map(s => new AnalyticSegment(s.labeled, s.id, s.from, s.to, s.deleted));
  }

  getStatusGenerator(
    id: AnalyticUnitId,
    duration: number
  ): AsyncIterableIterator<{ status: string, errorMessage?: string }> {
    return getGenerator<{ status: string, errorMessage?: string }>(
      id,
      duration,
      async (id) => {
        try {
          return this.get('/analyticUnits/status', { id });
        } catch(error) {
          if(error.status === 404) {
            return { status: '404' };
          }
          throw error;
        }
      }
    );
  }

  getDetectionsGenerator(
    id: AnalyticUnitId,
    from: number,
    to: number,
    duration: number
  ): AsyncIterableIterator<DetectionSpan[]> {
    return getGenerator<DetectionSpan[]>(
      id,
      duration,
      this.getDetectionSpans.bind(this),
      from,
      to
    );
  }

  async getServerInfo(): Promise<HasticServerInfo> {
    const data = await this.get('/');
    if(data === undefined) {
      return HasticServerInfoUnknown;
    }
    return {
      nodeVersion: data.nodeVersion,
      packageVersion: data.packageVersion,
      npmUserAgent: data.npmUserAgent,
      docker: data.docker,
      zmqConectionString: data.zmqConectionString,
      serverPort: data.serverPort,
      gitBranch: data.git.branch,
      gitCommitHash: data.git.commitHash
    };
  }

  async getHSR(analyticUnitId: AnalyticUnitId, from: number, to: number): Promise<{
    hsr: TableTimeSeries,
    lowerBound?: TableTimeSeries,
    upperBound?: TableTimeSeries
  } | null> {
    const data = await this.get('/query', { analyticUnitId, from, to });
    if(data === undefined) {
      return null;
    }
    return data.results;
  }

  async setAnalyticUnitAlert(analyticUnit: AnalyticUnit) {
    return this.patch('/analyticUnits/alert', {
      analyticUnitId: analyticUnit.id,
      alert: analyticUnit.alert
    });
  }

  async checkDatasourceAvailability(): Promise<boolean> {
    this.hasticDatasourceStatus.testing = true;

    this._isUp = await this._isDatasourceAvailable();

    this.hasticDatasourceStatus.testing = false;
    return this._isUp;
  }

  async updateAnalyticUnit(updateObj: any) {
    return this.patch('/analyticUnits', updateObj);
  }

  async runDetect(ids: AnalyticUnitId | AnalyticUnitId[], from?: number, to?: number) {
    if(!_.isArray(ids)) {
      ids = [ids];
    }
    return this.post('/analyticUnits/detect', { ids, from, to });
  }

  private async _analyticRequest(method: string, url: string, data?: any) {
    try {
      method = method.toUpperCase();
      url = this._hasticDatasourceURL + url;
      let requestObject: any = { method, url };
      if(method === 'GET' || method === 'DELETE') {
        requestObject.params = data;
      } else {
        requestObject.data = data;
      }
      const response = await this.$http(requestObject);
      this._isUp = true;
      return response.data;
    } catch(error) {
      // xhrStatus may be one of: ('complete', 'error', 'timeout' or 'abort')
      // See: https://github.com/angular/angular.js/blob/55075b840c9194b8524627a293d6166528b9a1c2/src/ng/http.js#L919-L920
      if(error.xhrStatus !== 'complete' || error.status > 500) {
        let statusText = error.status;
        if (error.statusText !== '') {
          status += ` (${error.statusText})`;
        }
        // -1 usually means the request was aborted, e.g. using a config.timeout
        // See: https://docs.angularjs.org/api/ng/service/$http#$http-returns
        if(error.status === 504 || error.status === -1) {
          this._displayConnectionTimeoutAlert(statusText);
        } else {
          this._displayNoConnectionAlert(statusText);
        }
        this._isUp = false;
        throw new Error(`Fetching error: ${statusText}`);
      } else {
        this._isUp = true;
      }
    }
  }

  get hasticDatasourceURL(): string {
    return this._hasticDatasourceURL;
  }

  private _checkDatasourceConfig(): boolean {
    if(this._hasticDatasourceURL === null || this._hasticDatasourceURL === undefined || this._hasticDatasourceURL === '') {
      appEvents.emit(
        'alert-warning',
        [
          `Hastic Datasource is missing`,
          `Please setup Hastic Datasource. More info: https://github.com/hastic/hastic-grafana-app/wiki/Getting-started`
        ]
      );
      return false;
    }
    return true;
  }

  private async get(url, params?) {
    return this._analyticRequest('GET', url, params);
  }

  private async post(url, data?) {
    return this._analyticRequest('POST', url, data);
  }

  private async patch(url, data?) {
    return this._analyticRequest('PATCH', url, data);
  }

  private async delete(url, data?) {
    return this._analyticRequest('DELETE', url, data);
  }

  private _displayNoConnectionAlert(statusText: string): void {
    const message = [
      `No connection to Hastic Server. Status: ${statusText}`,
      `Hastic Datasource URL: "${this._hasticDatasourceURL}"`,
    ]
    this._displayConnectionAlert(HasticDatasourceAvailability.NOT_AVAILABLE, message);
  }

  private _displayConnectionTimeoutAlert(statusText: string): void {
    const message = [
      `Timeout when connecting to Hastic Server. Status: ${statusText}`,
      `Hastic Datasource URL: "${this._hasticDatasourceURL}"`,
    ]
    this._displayConnectionAlert(HasticDatasourceAvailability.NOT_AVAILABLE, message);
  }

  private displayWrongUrlAlert(): void {
    const message = [
      'Please check Hastic Server URL',
      `Something is working at "${this._hasticDatasourceURL}" but it's not Hastic Server`,
    ]
    this._displayConnectionAlert(HasticDatasourceAvailability.NOT_AVAILABLE, message);
  }

  private displayUnsupportedVersionAlert(actual: string): void {
    const message = [
      'Unsupported Hastic Server version',
      `Hastic Server at "${this._hasticDatasourceURL}" has unsupported version (got ${actual}, should be ${SUPPORTED_SERVER_VERSION})`,
    ]
    this._displayConnectionAlert(HasticDatasourceAvailability.NOT_AVAILABLE, message);
  }

  public get isUp(): boolean {
    return this._isUp;
  }

  private _displayConnectionAlert(status: HasticDatasourceAvailability, message: string[]): void {
    this.hasticDatasourceStatus.availability = status;
    this.hasticDatasourceStatus.message = message.join('<br /> ');

    const statusChanged = this._updateHasticUrlStatus(status);

    if(!statusChanged) {
      return;
    }

    appEvents.emit(
      `alert-${status}`,
      message
    );
  }

  /**
   * Updates hastic datasource status
   * @returns true if status has been changed
   */
  private _updateHasticUrlStatus(status: HasticDatasourceAvailability): boolean {
    if(!window.hasOwnProperty('hasticDatasourcesAvailability')) {
      window.hasticDatasourcesAvailability = {};
    }
    if(!window.hasticDatasourcesAvailability.hasOwnProperty(this._hasticDatasourceURL)) {
      window.hasticDatasourcesAvailability[this._hasticDatasourceURL] = status;
      return true;
    }
    if(window.hasticDatasourcesAvailability[this._hasticDatasourceURL] !== status) {
      appEvents.emit('hastic-datasource-status-changed', this._hasticDatasourceURL);
      window.hasticDatasourcesAvailability[this._hasticDatasourceURL] = status;
      return true;
    }
    return false;
  }

}

async function *getGenerator<T>(
  id: AnalyticUnitId,
  duration: number,
  func: (...args: any[]) => Promise<T>,
  ...args
): AsyncIterableIterator<T> {
  if(id === undefined) {
    throw new Error('id is undefined');
  }

  let timeout = async () => new Promise(
    resolve => setTimeout(resolve, duration)
  );

  while(true) {
    yield await func(id, ...args);
    await timeout();
  }
}
