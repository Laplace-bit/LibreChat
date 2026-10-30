import { EModelEndpoint } from 'librechat-data-provider';
import { useFormContext, Controller } from 'react-hook-form';
import { useLocalize } from '~/hooks';
import InputWithLabel from './InputWithLabel';

const OpenAIConfig = ({
  endpoint,
  userProvideURL,
}: {
  endpoint: EModelEndpoint | string;
  userProvideURL?: boolean | null;
}) => {
  const localize = useLocalize();
  const { control } = useFormContext();
  const isAzure = endpoint === EModelEndpoint.azureOpenAI;
  return (
    <form className="flex-wrap">
      {!isAzure && (
        <Controller
          name="apiKey"
          control={control}
          render={({ field }) => (
            <InputWithLabel
              id="apiKey"
              {...field}
              label={localize('com_endpoint_config_openai_api_key')}
              labelClassName="mb-1"
              inputClassName="mb-2"
              secret
            />
          )}
        />
      )}
      {isAzure && (
        <>
          <Controller
            name="azureOpenAIApiKey"
            control={control}
            render={({ field }) => (
              <InputWithLabel
                id="azureOpenAIApiKey"
                {...field}
                label={localize('com_endpoint_config_azure_openai_api_key')}
                labelClassName="mb-1"
                secret
              />
            )}
          />
          <div className="mt-3"></div>
          <Controller
            name="azureOpenAIApiInstanceName"
            control={control}
            render={({ field }) => (
              <InputWithLabel
                id="azureOpenAIApiInstanceName"
                {...field}
                label={localize('com_endpoint_config_azure_openai_instance_name')}
                labelClassName="mb-1"
              />
            )}
          />
          <div className="mt-3"></div>
          <Controller
            name="azureOpenAIApiDeploymentName"
            control={control}
            render={({ field }) => (
              <InputWithLabel
                id="azureOpenAIApiDeploymentName"
                {...field}
                label={localize('com_endpoint_config_azure_openai_deployment_name')}
                labelClassName="mb-1"
              />
            )}
          />
          <div className="mt-3"></div>
          <Controller
            name="azureOpenAIApiVersion"
            control={control}
            render={({ field }) => (
              <InputWithLabel
                id="azureOpenAIApiVersion"
                {...field}
                label={localize('com_endpoint_config_azure_openai_api_version')}
                labelClassName="mb-1"
              />
            )}
          />
        </>
      )}
      {userProvideURL && (
        <div className="mt-3">
          <Controller
            name="baseURL"
            control={control}
            render={({ field }) => (
              <InputWithLabel
                id="baseURL"
                {...field}
                label={localize('com_endpoint_config_api_base_url')}
                subLabel={localize('com_ui_optional')}
                labelClassName="mb-1"
              />
            )}
          />
        </div>
      )}
    </form>
  );
};

export default OpenAIConfig;
