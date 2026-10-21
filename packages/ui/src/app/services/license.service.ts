import { Injectable } from '@angular/core';
import { HttpClient } from '@angular/common/http';

export interface OsiLicense {
  name: string;
  spdxId: string;
  category: string;
}

@Injectable({ providedIn: 'root' })
export class LicenseService {
  private licenses: OsiLicense[] | null = null;

  constructor(private http: HttpClient) {}

  loadLicenses(): Promise<OsiLicense[]> {
    if (this.licenses) {
      return Promise.resolve(this.licenses);
    }
    return this.http
      .get<OsiLicense[]>('/api/licenses')
      .toPromise()
      .then((data) => {
        this.licenses = data ?? [];
        return this.licenses;
      });
  }

  async searchLicenses(query: string): Promise<OsiLicense[]> {
    const q = (query ?? '').trim();
    const url = q ? `/api/licenses?q=${encodeURIComponent(q)}` : '/api/licenses';
    return this.http
      .get<OsiLicense[]>(url)
      .toPromise()
      .then((data) => data ?? []);
  }
}
