import { Injectable } from '@angular/core';
import { BehaviorSubject } from 'rxjs';

@Injectable({ providedIn: 'root' })
export class ReserveUiService {
  private readonly _open$ = new BehaviorSubject<boolean>(false);
  readonly open$ = this._open$.asObservable();

  open()  { this._open$.next(true); }
  close() { this._open$.next(false); }
}
