CREATE OR REPLACE FUNCTION public.redeem_invite_code(_code text)
RETURNS uuid
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = public
AS $$
DECLARE
  _invite invite_codes%ROWTYPE;
BEGIN
  -- Atomically find and increment in one statement
  UPDATE public.invite_codes
  SET use_count = use_count + 1
  WHERE code = upper(trim(_code))
    AND is_active = true
    AND use_count < max_uses
    AND (expires_at IS NULL OR expires_at > now())
  RETURNING * INTO _invite;

  IF _invite IS NULL THEN
    RETURN NULL;
  END IF;

  RETURN _invite.id;
END;
$$;
