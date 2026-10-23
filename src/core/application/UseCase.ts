import { Result } from '../result';

export interface IUseCase<IRequest, IResponse> {
  execute(request?: IRequest): Promise<Result<IResponse>> | Result<IResponse>;
}
